import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  currentIdentity,
  formatExit,
  identityIsAlive,
  readLockOwner,
  releaseOwnedLock,
  removeStaleLock,
  spawnManaged,
  stopManaged,
  stopOwned,
  tryCreateOwnedLock,
  unexpectedExit,
  type ManagedProcess,
  type OwnedProcessIdentity,
} from "./owned.js";
import { runExact as runProcessExact, type ExactCommandResult } from "./process.js";
import {
  browserCleanupComplete,
  browserCleanupRequired,
  finishState,
  hasLiveOwnedProcess,
  hasOwnedDisplayLock,
  isActive,
  parseConfig,
  publicationComplete,
  readProgressTail,
  readSessionConfig,
  readState,
  SESSION_SCHEMA_VERSION,
  sessionPaths,
  updateState,
  writeState,
  type NormalizedSessionConfig,
  type RecordingSessionState,
  type SessionPaths,
} from "./state.js";
import { uploadFinalMp4 } from "./uploads.js";
import {
  defined,
  delay,
  errorMessage,
  fileIsNonempty,
  hasCode,
  isRecord,
  parseObject,
  readBoundedText,
  remainingTimeout,
} from "./util.js";

const COMMAND_OUTPUT_LIMIT = 250_000;
const DEFAULT_MEDIA_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DISPLAY_MIN = 90;
const DISPLAY_COUNT = 100;

interface FinalizationProcessControl {
  readonly captureStarted: boolean;
  stopCapture(timeoutMs: number): Promise<void>;
  stopWindowManager(timeoutMs: number): Promise<void>;
  stopDisplay(timeoutMs: number): Promise<void>;
}

interface FinalizationResult {
  readonly state: RecordingSessionState;
  readonly failure?: string;
}

type FinalizationTimeout = (maximumMs: number, label: string) => number;

type FinalizationAttempt = (
  label: string,
  maximumMs: number,
  operation: (timeoutMs: number) => Promise<void>,
) => Promise<boolean>;

interface SuperviseProcesses {
  xvfb?: ManagedProcess;
  openbox?: ManagedProcess;
  ffmpeg?: ManagedProcess;
}

async function supervise(configPath: string): Promise<void> {
  const config = parseConfig(await readBoundedText(configPath), configPath);
  const supervisor = await currentIdentity();
  const paths = sessionPaths(config.runtimeDirectory);
  const browserId = `sv-${config.id.replaceAll("-", "").slice(0, 16)}`;
  const displayReservation = await acquireDisplay(config, supervisor);
  let state = await writeInitialState(config, supervisor, paths, displayReservation, browserId);

  const stop = watchStopSignal();
  const processes: SuperviseProcesses = {};
  const warnings: string[] = [];
  let failure: string | undefined;
  try {
    state = await startRecordingStack(config, paths, displayReservation.display, processes, state);
    await raceStopAgainstExits(stop.requested, processes);
  } catch (error) {
    failure = errorMessage(error);
    // startRecordingStack persisted owned PIDs and browser progress before it
    // threw; reload them so finalization does not overwrite disk with the
    // stale pre-startup snapshot.
    state = (await readState(config.runtimeDirectory).catch(() => null)) ?? state;
  }

  try {
    try {
      const finalized = await finalizeRecording(
        config,
        state,
        managedProcessControl(processes),
        (maximumMs) => maximumMs,
        warnings,
      );
      state = finalized.state;
      failure ??= finalized.failure;
    } catch (error) {
      failure ??= errorMessage(error);
      warnings.push(`finalization: ${errorMessage(error)}`);
    }
    if (failure === undefined && warnings.length > 0) {
      failure = `Recording cleanup was incomplete: ${warnings.join("; ")}`;
    }
    state = await finishState(state, failure, warnings);
    if (failure !== undefined) process.exitCode = 1;
  } finally {
    stop.dispose();
    if (!(await hasLiveOwnedProcess(state))) {
      await releaseOwnedLock(state.displayLockPath, supervisor);
    }
  }
}

async function writeInitialState(
  config: NormalizedSessionConfig,
  supervisor: OwnedProcessIdentity,
  paths: SessionPaths,
  displayReservation: { readonly display: string; readonly lockPath: string },
  browserId: string,
): Promise<RecordingSessionState> {
  const startedAt = new Date().toISOString();
  const state: RecordingSessionState = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: config.id,
    phase: "starting",
    runtimeDirectory: config.runtimeDirectory,
    display: displayReservation.display,
    xauthorityPath: paths.xauthorityPath,
    displayLockPath: displayReservation.lockPath,
    playlistPath: paths.playlistPath,
    segmentPattern: paths.segmentPattern,
    finalMp4Path: paths.finalMp4Path,
    supervisorLogPath: paths.supervisorLogPath,
    agentBrowserSession: browserId,
    agentBrowserNamespace: browserId,
    width: config.width,
    height: config.height,
    fps: config.fps,
    segmentDurationSeconds: config.segmentDurationSeconds,
    supervisor,
    phaseHistory: [{ phase: "starting", at: startedAt }],
    startedAt,
    updatedAt: startedAt,
  };
  try {
    await writeState(state);
  } catch (error) {
    await releaseOwnedLock(displayReservation.lockPath, supervisor);
    throw error;
  }
  return state;
}

function watchStopSignal(): { readonly requested: Promise<void>; readonly dispose: () => void } {
  let requestStop: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const onStop = () => requestStop?.();
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  return {
    requested,
    dispose: () => {
      process.removeListener("SIGINT", onStop);
      process.removeListener("SIGTERM", onStop);
    },
  };
}

/** Bring up Xauthority, Xvfb, openbox, the browser, and FFmpeg, persisting each owned PID. */
async function startRecordingStack(
  config: NormalizedSessionConfig,
  paths: SessionPaths,
  display: string,
  processes: SuperviseProcesses,
  initialState: RecordingSessionState,
): Promise<RecordingSessionState> {
  let state = initialState;
  await mkdir(paths.captureDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.captureDirectory, 0o700);
  const displayEnvironment = await createXauthority(config, paths, display);

  processes.xvfb = await spawnManaged(
    xvfbArgs(config, paths, display),
    displayEnvironment,
    paths.xvfbLogPath,
  );
  state = await updateState(state, { xvfb: processes.xvfb.identity });
  await waitForCommand(
    [config.executables.xdpyinfo, "-display", display],
    displayEnvironment,
    processes.xvfb,
    config.startupTimeoutMs,
  );

  processes.openbox = await spawnManaged(
    [config.executables.openbox, "--sm-disable"],
    displayEnvironment,
    paths.openboxLogPath,
  );
  state = await updateState(state, { openbox: processes.openbox.identity });
  await waitForCommand(
    [config.executables.xprop, "-root", "_NET_SUPPORTING_WM_CHECK"],
    displayEnvironment,
    processes.openbox,
    config.startupTimeoutMs,
    "_NET_SUPPORTING_WM_CHECK(WINDOW)",
  );

  state = await updateState(state, { browserStartAttemptedAt: new Date().toISOString() });
  await openInitialPage(config, displayEnvironment, state);

  processes.ffmpeg = await spawnManaged(
    ffmpegCaptureArgs(config, paths, display),
    displayEnvironment,
    paths.ffmpegLogPath,
  );
  state = await updateState(state, { ffmpeg: processes.ffmpeg.identity });
  await waitForFfmpeg(processes.ffmpeg, paths.ffmpegProgressPath, config.startupTimeoutMs);

  return updateState(state, { phase: "recording" });
}

async function createXauthority(
  config: NormalizedSessionConfig,
  paths: SessionPaths,
  display: string,
): Promise<NodeJS.ProcessEnv> {
  const cookieResult = await runExact([config.executables.mcookie], { timeoutMs: 5_000 });
  requireSuccess("mcookie", cookieResult);
  const cookie = cookieResult.stdout.trim();
  if (!/^[a-f0-9]+$/iu.test(cookie)) throw new Error("mcookie returned an invalid cookie");
  requireSuccess(
    "xauth",
    await runExact(
      [config.executables.xauth, "-f", paths.xauthorityPath, "add", display, ".", cookie],
      { timeoutMs: 5_000 },
    ),
  );
  await chmod(paths.xauthorityPath, 0o600);
  return { ...process.env, DISPLAY: display, XAUTHORITY: paths.xauthorityPath };
}

async function openInitialPage(
  config: NormalizedSessionConfig,
  displayEnvironment: NodeJS.ProcessEnv,
  state: RecordingSessionState,
): Promise<void> {
  const agentEnvironment = {
    ...displayEnvironment,
    AGENT_BROWSER_SESSION: state.agentBrowserSession,
    AGENT_BROWSER_NAMESPACE: state.agentBrowserNamespace,
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_NO_XVFB: "1",
    AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
    AGENT_BROWSER_ARGS: "--start-maximized",
  };
  requireSuccess(
    "agent-browser bootstrap",
    await runExact(
      [
        config.executables.agentBrowser,
        "--session",
        state.agentBrowserSession,
        "--namespace",
        state.agentBrowserNamespace,
        "--headed",
        "open",
        config.initialUrl,
      ],
      { environment: agentEnvironment, timeoutMs: config.startupTimeoutMs },
    ),
  );
}

function xvfbArgs(
  config: NormalizedSessionConfig,
  paths: SessionPaths,
  display: string,
): [string, ...string[]] {
  return [
    config.executables.xvfb,
    display,
    "-screen",
    "0",
    `${config.width}x${config.height}x24`,
    "-nolisten",
    "tcp",
    "-auth",
    paths.xauthorityPath,
  ];
}

function ffmpegCaptureArgs(
  config: NormalizedSessionConfig,
  paths: SessionPaths,
  display: string,
): [string, ...string[]] {
  const keyframeInterval = config.fps * 2;
  return [
    config.executables.ffmpeg,
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "x11grab",
    "-framerate",
    String(config.fps),
    "-video_size",
    `${config.width}x${config.height}`,
    "-i",
    `${display}.0`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "12",
    "-pix_fmt",
    "yuv420p",
    "-fps_mode",
    "passthrough",
    "-g",
    String(keyframeInterval),
    "-keyint_min",
    String(keyframeInterval),
    "-sc_threshold",
    "0",
    "-force_key_frames",
    `expr:gte(t,n_forced*${config.segmentDurationSeconds})`,
    "-f",
    "hls",
    "-hls_time",
    String(config.segmentDurationSeconds),
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "mpegts",
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_segment_filename",
    paths.segmentPattern,
    "-progress",
    paths.ffmpegProgressPath,
    "-stats_period",
    "0.25",
    "-nostats",
    paths.playlistPath,
  ];
}

/** Resolves on a stop signal; throws when any owned process exits first. */
async function raceStopAgainstExits(
  stopRequested: Promise<void>,
  processes: SuperviseProcesses,
): Promise<void> {
  const exits: Promise<{ readonly type: "exit"; readonly message: string }>[] = [];
  if (processes.xvfb !== undefined) exits.push(unexpectedExit("Xvfb", processes.xvfb));
  if (processes.openbox !== undefined) exits.push(unexpectedExit("openbox", processes.openbox));
  if (processes.ffmpeg !== undefined) exits.push(unexpectedExit("FFmpeg", processes.ffmpeg));
  const event = await Promise.race([
    stopRequested.then(() => ({ type: "stop" as const })),
    ...exits,
  ]);
  if (event.type === "exit") throw new Error(event.message);
}

async function finalizeRecording(
  config: NormalizedSessionConfig,
  initialState: RecordingSessionState,
  control: FinalizationProcessControl,
  timeout: FinalizationTimeout,
  warnings: string[],
  initialFailure?: string,
): Promise<FinalizationResult> {
  let state = initialState;
  let failure = initialFailure;
  let captureStopped = true;
  const attempt = async (
    label: string,
    maximumMs: number,
    operation: (timeoutMs: number) => Promise<void>,
  ): Promise<boolean> => {
    try {
      await operation(timeout(maximumMs, label));
      return true;
    } catch (error) {
      const message = `${label}: ${errorMessage(error)}`;
      warnings.push(message);
      failure ??= message;
      return false;
    }
  };

  try {
    state = await closeBrowserPhase(config, state, attempt);
    state = await updateState(state, { phase: "stopping_capture" });
    if (control.captureStarted) {
      captureStopped = await attempt("FFmpeg cleanup", config.stopTimeoutMs, control.stopCapture);
    }
    const produced = await producePhase(config, state, control, captureStopped, timeout, warnings);
    state = produced.state;
    failure ??= produced.failure;
    if (config.upload !== undefined && state.publication === undefined) {
      failure ??= "Recording finished without an uploaded MP4";
    }
  } catch (error) {
    failure ??= errorMessage(error);
  }

  try {
    state = await updateState(state, { phase: "cleaning_up" });
  } catch (error) {
    const message = `recording state cleanup: ${errorMessage(error)}`;
    warnings.push(message);
    failure ??= message;
  }
  await attempt("openbox cleanup", 3_000, control.stopWindowManager);
  await attempt("Xvfb cleanup", 3_000, control.stopDisplay);
  await unlink(state.xauthorityPath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return;
    const message = `Xauthority cleanup: ${errorMessage(error)}`;
    warnings.push(message);
    failure ??= message;
  });

  return { state, ...defined({ failure }) };
}

async function closeBrowserPhase(
  config: NormalizedSessionConfig,
  initialState: RecordingSessionState,
  attempt: FinalizationAttempt,
): Promise<RecordingSessionState> {
  if (!browserCleanupRequired(initialState) || initialState.browserClosedAt !== undefined) {
    return initialState;
  }
  const state = await updateState(initialState, { phase: "closing_browser" });
  const browserClosed = await attempt("agent-browser cleanup", config.stopTimeoutMs, (timeoutMs) =>
    closeAgentBrowser(config, state, timeoutMs),
  );
  return browserClosed ? updateState(state, { browserClosedAt: new Date().toISOString() }) : state;
}

async function producePhase(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  control: FinalizationProcessControl,
  captureStopped: boolean,
  timeout: FinalizationTimeout,
  warnings: string[],
): Promise<FinalizationResult> {
  if (!captureStopped || state.publication !== undefined) return { state };
  if (await fileIsNonempty(state.playlistPath)) {
    return { state: await produceAndPublishMp4(config, state, timeout, warnings) };
  }
  return control.captureStarted
    ? { state, failure: "Recording supervisor stopped without producing an HLS playlist" }
    : { state };
}

/** Remux the HLS capture into one verified MP4, then upload it when configured. */
async function produceAndPublishMp4(
  config: NormalizedSessionConfig,
  initialState: RecordingSessionState,
  timeout: FinalizationTimeout,
  warnings: string[],
): Promise<RecordingSessionState> {
  let state = await updateState(initialState, { phase: "finalizing_mp4" });
  const temporaryMp4Path = join(state.runtimeDirectory, `.recording-${randomUUID()}.tmp.mp4`);
  try {
    requireSuccess(
      "final MP4 remux",
      await runExact(
        [
          config.executables.ffmpeg,
          "-y",
          "-v",
          "error",
          "-i",
          state.playlistPath,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          temporaryMp4Path,
        ],
        { timeoutMs: timeout(DEFAULT_MEDIA_COMMAND_TIMEOUT_MS, "MP4 finalization") },
      ),
    );
    if (!(await fileIsNonempty(temporaryMp4Path))) {
      throw new Error("Final MP4 remux produced no file");
    }
    await verifyFinalMp4(
      config,
      temporaryMp4Path,
      timeout(DEFAULT_MEDIA_COMMAND_TIMEOUT_MS, "MP4 verification"),
    );
    await rename(temporaryMp4Path, state.finalMp4Path);
  } finally {
    await unlink(temporaryMp4Path).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) {
        warnings.push(`temporary MP4 cleanup: ${errorMessage(error)}`);
      }
    });
  }
  if (config.upload !== undefined) {
    state = await updateState(state, { phase: "uploading_mp4" });
    const publication = await uploadFinalMp4({
      filePath: state.finalMp4Path,
      key: config.upload.key,
      ...defined({ workspace: config.upload.workspace }),
      ...defined({ executable: config.upload.executable }),
      timeoutMs: timeout(DEFAULT_MEDIA_COMMAND_TIMEOUT_MS, "MP4 upload"),
    });
    state = await updateState(state, { publication });
  }
  return state;
}

function managedProcessControl(processes: SuperviseProcesses): FinalizationProcessControl {
  return {
    captureStarted: processes.ffmpeg !== undefined,
    stopCapture: async (timeoutMs) => {
      if (processes.ffmpeg !== undefined) {
        await stopManaged(processes.ffmpeg, "SIGINT", timeoutMs);
      }
    },
    stopWindowManager: async (timeoutMs) => {
      if (processes.openbox !== undefined) {
        await stopManaged(processes.openbox, "SIGTERM", timeoutMs);
      }
    },
    stopDisplay: async (timeoutMs) => {
      if (processes.xvfb !== undefined) {
        await stopManaged(processes.xvfb, "SIGTERM", timeoutMs);
      }
    },
  };
}

function ownedProcessControl(state: RecordingSessionState): FinalizationProcessControl {
  return {
    captureStarted: state.ffmpeg !== undefined,
    stopCapture: async (timeoutMs) => {
      if (state.ffmpeg !== undefined) await stopOwned(state.ffmpeg, "SIGINT", timeoutMs);
    },
    stopWindowManager: async (timeoutMs) => {
      if (state.openbox !== undefined) await stopOwned(state.openbox, "SIGTERM", timeoutMs);
    },
    stopDisplay: async (timeoutMs) => {
      if (state.xvfb !== undefined) await stopOwned(state.xvfb, "SIGTERM", timeoutMs);
    },
  };
}

export async function recoverSession(
  runtimeDirectory: string,
  deadline: number,
): Promise<RecordingSessionState> {
  let state = await readState(runtimeDirectory);
  if (state === null) throw new Error("Recording state disappeared during stop");
  const config = await readSessionConfig(runtimeDirectory);
  if (await isFullyReleased(state, config)) return state;
  const retryingTerminalState = !isActive(state.phase);
  const warnings: string[] = [];
  const finalized = await finalizeRecording(
    config,
    state,
    ownedProcessControl(state),
    (maximumMs, label) => remainingTimeout(deadline, maximumMs, label),
    warnings,
    retryingTerminalState ? undefined : state.failure,
  );
  state = finalized.state;
  let failure = finalized.failure;
  if (await hasLiveOwnedProcess(state)) {
    failure ??= "Recording-owned processes remained alive after cleanup";
  } else {
    await releaseOwnedLock(state.displayLockPath, state.supervisor);
  }
  if (failure === undefined) {
    const { failure: _failure, warnings: _warnings, ...cleanState } = state;
    state = cleanState;
  }
  return finishState(state, failure, warnings);
}

/** True once nothing owned by the recording remains: processes, locks, browser, upload. */
export async function isFullyReleased(
  state: RecordingSessionState,
  config: NormalizedSessionConfig,
): Promise<boolean> {
  return (
    !isActive(state.phase) &&
    !(await hasLiveOwnedProcess(state)) &&
    !(await hasOwnedDisplayLock(state)) &&
    browserCleanupComplete(state) &&
    publicationComplete(state, config)
  );
}

async function closeAgentBrowser(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  timeoutMs = Math.min(config.stopTimeoutMs, 10_000),
): Promise<void> {
  const result = await runExact(
    [
      config.executables.agentBrowser,
      "--session",
      state.agentBrowserSession,
      "--namespace",
      state.agentBrowserNamespace,
      "close",
    ],
    {
      environment: {
        ...process.env,
        DISPLAY: state.display,
        XAUTHORITY: state.xauthorityPath,
        AGENT_BROWSER_SESSION: state.agentBrowserSession,
        AGENT_BROWSER_NAMESPACE: state.agentBrowserNamespace,
        AGENT_BROWSER_NO_XVFB: "1",
      },
      timeoutMs,
    },
  );
  requireSuccess("agent-browser close", result);
}

async function verifyFinalMp4(
  config: NormalizedSessionConfig,
  path: string,
  timeoutMs: number,
): Promise<void> {
  const probe = await runExact(
    [
      config.executables.ffprobe,
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_frames",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path,
    ],
    { timeoutMs },
  );
  requireSuccess("final MP4 probe", probe);
  if (!matchesRequestedFormat(probeReport(probe.stdout), config)) {
    throw new Error("Final MP4 does not match the requested H.264/yuv420p geometry and FPS");
  }
  const decode = await runExact(
    [config.executables.ffmpeg, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "null", "-"],
    { timeoutMs },
  );
  requireSuccess("final MP4 decode", decode);
}

interface ProbeReport {
  readonly video: Record<string, unknown>;
  readonly container: Record<string, unknown>;
}

function probeReport(stdout: string): ProbeReport {
  const parsed = parseObject(stdout, "ffprobe output");
  const stream =
    Array.isArray(parsed.streams) && parsed.streams.length === 1 ? parsed.streams[0] : undefined;
  if (!isRecord(stream) || !isRecord(parsed.format)) {
    throw new Error("Final MP4 is missing its video stream or duration");
  }
  return { video: stream, container: parsed.format };
}

function matchesRequestedFormat(report: ProbeReport, config: NormalizedSessionConfig): boolean {
  const { video, container } = report;
  const measuredFps = parseFrameRate(video.avg_frame_rate);
  const frames = typeof video.nb_frames === "string" ? Number(video.nb_frames) : Number.NaN;
  const duration = typeof container.duration === "string" ? Number(container.duration) : Number.NaN;
  return (
    video.codec_name === "h264" &&
    video.pix_fmt === "yuv420p" &&
    video.width === config.width &&
    video.height === config.height &&
    measuredFps !== null &&
    Math.abs(measuredFps - config.fps) <= 0.01 &&
    Number.isSafeInteger(frames) &&
    frames > 0 &&
    Number.isFinite(duration) &&
    duration > 0
  );
}

function parseFrameRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (match === null) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

async function acquireDisplay(
  config: NormalizedSessionConfig,
  owner: OwnedProcessIdentity,
): Promise<{ readonly display: string; readonly lockPath: string }> {
  const first = config.displayNumber ?? DISPLAY_MIN + (owner.pid % DISPLAY_COUNT);
  const attempts = config.displayNumber === undefined ? DISPLAY_COUNT : 1;
  for (let offset = 0; offset < attempts; offset += 1) {
    const number =
      config.displayNumber ?? DISPLAY_MIN + ((first - DISPLAY_MIN + offset) % DISPLAY_COUNT);
    const lockPath = `/tmp/sandbox-video-display-${number}.lock`;
    if (await tryCreateOwnedLock(lockPath, owner)) {
      return { display: `:${number}`, lockPath };
    }
    const stale = await readLockOwner(lockPath);
    if (stale !== null && !(await identityIsAlive(stale))) {
      if (await removeStaleLock(lockPath, owner)) offset -= 1;
    }
  }
  throw new Error("No recording-owned X display is available");
}

async function waitForCommand(
  argv: readonly [string, ...string[]],
  environment: NodeJS.ProcessEnv,
  owner: ManagedProcess,
  timeoutMs: number,
  stdoutIncludes?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let detail = "not ready";
  while (Date.now() < deadline) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
      throw new Error(`${owner.identity.executable} exited before readiness`);
    }
    const result = await runExact(argv, { environment, timeoutMs: 2_000 });
    if (
      result.exitCode === 0 &&
      (stdoutIncludes === undefined || result.stdout.includes(stdoutIncludes))
    ) {
      return;
    }
    detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    await delay(100);
  }
  throw new Error(`${argv[0]} readiness timed out: ${detail.slice(0, 500)}`);
}

async function waitForFfmpeg(
  ffmpeg: ManagedProcess,
  progressPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ffmpeg.child.exitCode !== null || ffmpeg.child.signalCode !== null) {
      throw new Error("FFmpeg exited before capture readiness");
    }
    try {
      const progress = await readProgressTail(progressPath);
      if (/^frame=[1-9]\d*$/mu.test(progress)) return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    await delay(50);
  }
  throw new Error("FFmpeg capture readiness timed out");
}

async function runExact(
  argv: readonly [string, ...string[]],
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
): Promise<ExactCommandResult> {
  return runProcessExact(argv, {
    ...options,
    outputLimitBytes: COMMAND_OUTPUT_LIMIT,
  });
}

function requireSuccess(label: string, result: ExactCommandResult): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || formatExit(result);
    throw new Error(`${label} failed: ${detail.slice(0, 1_000)}`);
  }
}

// The realpath fallback keeps the check correct when NODE_OPTIONS carries
// --preserve-symlinks, where argv[1] may stay a symlink while the module URL
// is resolved.
const entryPath = process.argv[1];
const isEntryModule =
  entryPath !== undefined &&
  (import.meta.url === pathToFileURL(entryPath).href ||
    import.meta.url === pathToFileURL(await realpath(entryPath).catch(() => entryPath)).href);

if (isEntryModule) {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    process.stderr.write("Missing recording supervisor config path\n");
    process.exitCode = 1;
  } else {
    void supervise(configPath).catch((error: unknown) => {
      process.stderr.write(`Recording supervisor failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  }
}

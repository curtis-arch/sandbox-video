import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertUploadsKey,
  assertUploadsWorkspace,
  uploadFinalMp4,
  type UploadsPublication,
} from "./uploads.js";
import { runExact as runProcessExact, type ExactCommandResult } from "./process.js";

const SESSION_SCHEMA_VERSION = 1 as const;
const SUPERVISOR_MODE = "__sandbox_video_supervise__";
const STATE_NAME = "session.json";
const CONFIG_NAME = "session-config.json";
const SUPERVISOR_LOG_NAME = "supervisor.log";
const RECOVERY_LOCK_NAME = "recovery.lock";
const COMMAND_OUTPUT_LIMIT = 250_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MEDIA_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DISPLAY_MIN = 90;
const DISPLAY_COUNT = 100;

export type RecordingSessionPhase =
  | "starting"
  | "recording"
  | "closing_browser"
  | "stopping_capture"
  | "finalizing_mp4"
  | "uploading_mp4"
  | "cleaning_up"
  | "finished"
  | "failed";

export const RECORDING_STOP_PHASES = [
  "closing_browser",
  "stopping_capture",
  "finalizing_mp4",
  "uploading_mp4",
  "cleaning_up",
] as const satisfies readonly RecordingSessionPhase[];

export interface RecordingExecutables {
  readonly agentBrowser?: string;
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly mcookie?: string;
  readonly openbox?: string;
  readonly xauth?: string;
  readonly xdpyinfo?: string;
  readonly xprop?: string;
  readonly xvfb?: string;
}

export interface RecordingUploadOptions {
  readonly key: string;
  readonly workspace?: string;
  readonly executable?: string;
}

export interface StartSessionOptions {
  readonly recordingId?: string;
  readonly runtimeDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly fps: 30 | 60;
  readonly segmentDurationSeconds?: number;
  readonly initialUrl?: string;
  readonly displayNumber?: number;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly executables?: RecordingExecutables;
  readonly upload?: RecordingUploadOptions;
}

export interface StopSessionOptions {
  readonly runtimeDirectory: string;
  readonly timeoutMs?: number;
}

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly executable: string;
}

export interface RecordingSessionState {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly phase: RecordingSessionPhase;
  readonly runtimeDirectory: string;
  readonly display: string;
  readonly xauthorityPath: string;
  readonly displayLockPath: string;
  readonly playlistPath: string;
  readonly segmentPattern: string;
  readonly finalMp4Path: string;
  readonly supervisorLogPath: string;
  readonly agentBrowserSession: string;
  readonly agentBrowserNamespace: string;
  readonly width: number;
  readonly height: number;
  readonly fps: 30 | 60;
  readonly segmentDurationSeconds: number;
  readonly supervisor: OwnedProcessIdentity;
  readonly xvfb?: OwnedProcessIdentity;
  readonly openbox?: OwnedProcessIdentity;
  readonly ffmpeg?: OwnedProcessIdentity;
  readonly publication?: UploadsPublication;
  readonly browserStartAttemptedAt?: string;
  readonly browserClosedAt?: string;
  readonly phaseHistory: readonly {
    readonly phase: RecordingSessionPhase;
    readonly at: string;
  }[];
  readonly failure?: string;
  readonly warnings?: readonly string[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
}

export interface RecordingCaptureProgress {
  readonly frame: number;
  readonly outputTimeMs: number;
}

export type RecordingSessionStatus =
  | {
      readonly exists: false;
      readonly runtimeDirectory: string;
    }
  | {
      readonly exists: true;
      readonly supervisorAlive: boolean;
      readonly state: RecordingSessionState;
      readonly capture: RecordingCaptureProgress;
    };

interface NormalizedSessionConfig {
  readonly id: string;
  readonly runtimeDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly fps: 30 | 60;
  readonly segmentDurationSeconds: number;
  readonly initialUrl: string;
  readonly displayNumber?: number;
  readonly startupTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly executables: Required<RecordingExecutables>;
  readonly upload?: RecordingUploadOptions;
}

interface ManagedProcess {
  readonly child: ChildProcess;
  readonly identity: OwnedProcessIdentity;
  readonly exit: Promise<ProcessExit>;
}

interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

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

/** Start one recording, or return the durable result of an earlier call for this directory. */
export async function startSession(options: StartSessionOptions): Promise<RecordingSessionState> {
  const config = normalizeOptions(options);
  await ensureRuntimeDirectory(config.runtimeDirectory);
  const existing = await readState(config.runtimeDirectory);
  if (existing !== null) {
    assertCompatibleSession(existing, config);
    return waitForStarted(existing, config.startupTimeoutMs);
  }

  const configPath = join(config.runtimeDirectory, CONFIG_NAME);
  try {
    await writeFile(configPath, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const state = await waitForState(config.runtimeDirectory, config.startupTimeoutMs);
    assertCompatibleSession(state, config);
    return state;
  }

  const logPath = join(config.runtimeDirectory, SUPERVISOR_LOG_NAME);
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), SUPERVISOR_MODE, configPath],
      {
        detached: true,
        env: process.env,
        shell: false,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await waitForSpawn(child);
    child.unref();
  } catch (error) {
    await unlink(configPath).catch(() => undefined);
    throw error;
  } finally {
    await log.close();
  }
  const state = await waitForState(config.runtimeDirectory, config.startupTimeoutMs);
  assertCompatibleSession(state, config);
  return state;
}

/** Read durable state without requiring the original caller or process handles. */
export async function getSessionStatus(runtimeDirectory: string): Promise<RecordingSessionStatus> {
  const directory = validateRuntimeDirectory(runtimeDirectory);
  const state = await readState(directory);
  if (state === null) return { exists: false, runtimeDirectory: directory };
  const supervisorAlive = await identityIsAlive(state.supervisor);
  const capture = await readCaptureProgress(sessionPaths(directory).ffmpegProgressPath);
  return { exists: true, supervisorAlive, state, capture };
}

async function isRecoveredTerminal(
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

async function isStopComplete(
  status: Extract<RecordingSessionStatus, { readonly exists: true }>,
  config: NormalizedSessionConfig,
): Promise<boolean> {
  return isRecoveredTerminal(status.state, config);
}

async function failIfStopTimedOut(
  directory: string,
  deadline: number,
): Promise<RecordingSessionStatus | undefined> {
  if (Date.now() < deadline) return undefined;
  return failStopAtDeadline(directory, "Recording stop exceeded its timeout");
}

async function requestSupervisorExit(
  state: RecordingSessionState,
  directory: string,
  deadline: number,
  timeoutMs: number,
): Promise<RecordingSessionStatus | undefined> {
  await signalOwned(state.supervisor, "SIGTERM");
  const terminal = await waitForTerminalState(
    directory,
    remainingTimeout(deadline, timeoutMs, "stop"),
  );
  if (terminal !== null) return terminal;
  await signalOwned(state.supervisor, "SIGKILL");
  const afterKill = await failIfStopTimedOut(directory, deadline);
  if (afterKill !== undefined) return afterKill;
  await waitForIdentityExit(state.supervisor, remainingTimeout(deadline, 2_000, "stop"));
  return failIfStopTimedOut(directory, deadline);
}

async function recoverOrWait(
  directory: string,
  deadline: number,
  timeoutMs: number,
): Promise<RecordingSessionStatus> {
  const recoveryOwner = await currentIdentity();
  const recoveryLockPath = join(directory, RECOVERY_LOCK_NAME);
  if (!(await acquireRecoveryLock(recoveryLockPath, recoveryOwner))) {
    const terminal = await waitForTerminalState(
      directory,
      remainingTimeout(deadline, timeoutMs, "concurrent stop"),
      false,
    );
    if (terminal !== null) return terminal;
    throw new Error("Another stop process did not finish before the timeout");
  }
  try {
    const recovered = await recoverSession(directory, deadline);
    return {
      exists: true,
      supervisorAlive: false,
      state: recovered,
      capture: await readCaptureProgress(sessionPaths(directory).ffmpegProgressPath),
    };
  } catch (error) {
    const current = await readState(directory);
    if (current === null) throw error;
    const now = new Date().toISOString();
    const recovered = await updateState(current, {
      phase: "failed",
      failure: errorMessage(error),
      updatedAt: now,
      finishedAt: now,
    });
    return {
      exists: true,
      supervisorAlive: false,
      state: recovered,
      capture: await readCaptureProgress(sessionPaths(directory).ffmpegProgressPath),
    };
  } finally {
    await releaseDisplayLock(recoveryLockPath, recoveryOwner);
  }
}

/** Stop and finalize a recording. Repeated calls return the same terminal state. */
export async function stopSession(options: StopSessionOptions): Promise<RecordingSessionStatus> {
  const directory = validateRuntimeDirectory(options.runtimeDirectory);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS,
    "timeoutMs",
  );
  const deadline = Date.now() + timeoutMs;
  const first = await getSessionStatus(directory);
  if (!first.exists) return first;
  const config = await readSessionConfig(directory);
  if (await isStopComplete(first, config)) return first;

  if (isActive(first.state.phase) && first.supervisorAlive) {
    const stopped = await requestSupervisorExit(first.state, directory, deadline, timeoutMs);
    if (stopped !== undefined) return stopped;
  }
  return recoverOrWait(directory, deadline, timeoutMs);
}

function displayEnvironmentFor(display: string, xauthorityPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DISPLAY: display,
    XAUTHORITY: xauthorityPath,
  };
}

async function writeXauthority(
  config: NormalizedSessionConfig,
  xauthorityPath: string,
  display: string,
): Promise<void> {
  const cookieResult = await runExact([config.executables.mcookie], { timeoutMs: 5_000 });
  requireSuccess("mcookie", cookieResult);
  const cookie = cookieResult.stdout.trim();
  if (!/^[a-f0-9]+$/iu.test(cookie)) throw new Error("mcookie returned an invalid cookie");
  requireSuccess(
    "xauth",
    await runExact([config.executables.xauth, "-f", xauthorityPath, "add", display, ".", cookie], {
      timeoutMs: 5_000,
    }),
  );
  await chmod(xauthorityPath, 0o600);
}

async function spawnXvfb(
  config: NormalizedSessionConfig,
  display: string,
  xauthorityPath: string,
  environment: NodeJS.ProcessEnv,
  logPath: string,
): Promise<ManagedProcess> {
  return spawnManaged(
    [
      config.executables.xvfb,
      display,
      "-screen",
      "0",
      `${config.width}x${config.height}x24`,
      "-nolisten",
      "tcp",
      "-auth",
      xauthorityPath,
    ],
    environment,
    logPath,
  );
}

async function spawnOpenbox(
  environment: NodeJS.ProcessEnv,
  executable: string,
  logPath: string,
): Promise<ManagedProcess> {
  return spawnManaged([executable, "--sm-disable"], environment, logPath);
}

function ffmpegCaptureArgv(
  config: NormalizedSessionConfig,
  display: string,
  paths: ReturnType<typeof sessionPaths>,
): readonly [string, ...string[]] {
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

async function openAgentBrowser(
  config: NormalizedSessionConfig,
  session: string,
  namespace: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  requireSuccess(
    "agent-browser bootstrap",
    await runExact(
      [
        config.executables.agentBrowser,
        "--session",
        session,
        "--namespace",
        namespace,
        "--headed",
        "open",
        config.initialUrl,
      ],
      { environment, timeoutMs: config.startupTimeoutMs },
    ),
  );
}

function listenForStop(): { readonly stopSignal: Promise<void>; detach(): void } {
  let stopRequested = false;
  let requestStop: (() => void) | undefined;
  const stopSignal = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const onStop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    requestStop?.();
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  return {
    stopSignal,
    detach() {
      process.removeListener("SIGINT", onStop);
      process.removeListener("SIGTERM", onStop);
    },
  };
}

async function completeSupervisor(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  processes: {
    readonly xvfb?: ManagedProcess;
    readonly openbox?: ManagedProcess;
    readonly ffmpeg?: ManagedProcess;
  },
  warnings: string[],
  failure: string | undefined,
): Promise<void> {
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
  const now = new Date().toISOString();
  await updateState(state, {
    phase: failure === undefined ? "finished" : "failed",
    ...(failure === undefined ? {} : { failure }),
    ...(warnings.length === 0 ? {} : { warnings }),
    updatedAt: now,
    finishedAt: now,
  });
  if (failure !== undefined) process.exitCode = 1;
}

async function supervise(configPath: string): Promise<void> {
  const config = parseConfig(await readBoundedText(configPath), configPath);
  const supervisor = await currentIdentity();
  const paths = sessionPaths(config.runtimeDirectory);
  const browserId = `sv-${config.id.replaceAll("-", "").slice(0, 16)}`;
  const agentBrowserSession = browserId;
  const agentBrowserNamespace = browserId;
  const displayReservation = await acquireDisplay(config, supervisor);
  const startedAt = new Date().toISOString();
  let state: RecordingSessionState = {
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
    agentBrowserSession,
    agentBrowserNamespace,
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
    await releaseDisplayLock(displayReservation.lockPath, supervisor);
    throw error;
  }

  let xvfb: ManagedProcess | undefined;
  let openbox: ManagedProcess | undefined;
  let ffmpeg: ManagedProcess | undefined;
  const stop = listenForStop();
  const warnings: string[] = [];
  let failure: string | undefined;
  try {
    await mkdir(paths.captureDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.captureDirectory, 0o700);
    await writeXauthority(config, paths.xauthorityPath, displayReservation.display);
    const displayEnvironment = displayEnvironmentFor(
      displayReservation.display,
      paths.xauthorityPath,
    );
    xvfb = await spawnXvfb(
      config,
      displayReservation.display,
      paths.xauthorityPath,
      displayEnvironment,
      paths.xvfbLogPath,
    );
    state = await updateState(state, { xvfb: xvfb.identity });
    await waitForCommand(
      [config.executables.xdpyinfo, "-display", displayReservation.display],
      displayEnvironment,
      xvfb,
      config.startupTimeoutMs,
    );
    openbox = await spawnOpenbox(
      displayEnvironment,
      config.executables.openbox,
      paths.openboxLogPath,
    );
    state = await updateState(state, { openbox: openbox.identity });
    await waitForCommand(
      [config.executables.xprop, "-root", "_NET_SUPPORTING_WM_CHECK"],
      displayEnvironment,
      openbox,
      config.startupTimeoutMs,
      "_NET_SUPPORTING_WM_CHECK(WINDOW)",
    );
    state = await updateState(state, { browserStartAttemptedAt: new Date().toISOString() });
    await openAgentBrowser(config, agentBrowserSession, agentBrowserNamespace, {
      ...displayEnvironment,
      AGENT_BROWSER_SESSION: agentBrowserSession,
      AGENT_BROWSER_NAMESPACE: agentBrowserNamespace,
      AGENT_BROWSER_HEADED: "1",
      AGENT_BROWSER_NO_XVFB: "1",
      AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
      AGENT_BROWSER_ARGS: "--start-maximized",
    });
    ffmpeg = await spawnManaged(
      ffmpegCaptureArgv(config, displayReservation.display, paths),
      displayEnvironment,
      paths.ffmpegLogPath,
    );
    state = await updateState(state, { ffmpeg: ffmpeg.identity });
    await waitForFfmpeg(ffmpeg, paths.ffmpegProgressPath, config.startupTimeoutMs);
    state = await updateState(state, { phase: "recording" });
    const event = await Promise.race([
      stop.stopSignal.then(() => ({ type: "stop" as const })),
      unexpectedExit("Xvfb", xvfb),
      unexpectedExit("openbox", openbox),
      unexpectedExit("FFmpeg", ffmpeg),
    ]);
    if (event.type === "exit") throw new Error(event.message);
  } catch (error) {
    failure = errorMessage(error);
  }

  try {
    await completeSupervisor(
      config,
      state,
      {
        ...(xvfb === undefined ? {} : { xvfb }),
        ...(openbox === undefined ? {} : { openbox }),
        ...(ffmpeg === undefined ? {} : { ffmpeg }),
      },
      warnings,
      failure,
    );
  } finally {
    stop.detach();
    if (!(await hasLiveOwnedProcess(state))) {
      await releaseDisplayLock(state.displayLockPath, supervisor);
    }
  }
}

async function closeBrowserIfNeeded(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  timeout: FinalizationTimeout,
  note: (message: string) => void,
): Promise<RecordingSessionState> {
  if (!browserCleanupRequired(state) || state.browserClosedAt !== undefined) return state;
  state = await updateState(state, { phase: "closing_browser" });
  const message = await attemptCleanup(
    "agent-browser cleanup",
    timeout(config.stopTimeoutMs, "agent-browser cleanup"),
    (timeoutMs) => closeAgentBrowser(config, state, timeoutMs),
  );
  if (message !== undefined) {
    note(message);
    return state;
  }
  return updateState(state, { browserClosedAt: new Date().toISOString() });
}

async function remuxAndVerifyMp4(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  timeout: FinalizationTimeout,
): Promise<void> {
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
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

async function publishFinalMp4IfConfigured(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  timeout: FinalizationTimeout,
): Promise<RecordingSessionState> {
  if (config.upload === undefined) return state;
  state = await updateState(state, { phase: "uploading_mp4" });
  const publication = await uploadFinalMp4({
    filePath: state.finalMp4Path,
    key: config.upload.key,
    ...(config.upload.workspace === undefined ? {} : { workspace: config.upload.workspace }),
    ...(config.upload.executable === undefined ? {} : { executable: config.upload.executable }),
    timeoutMs: timeout(DEFAULT_MEDIA_COMMAND_TIMEOUT_MS, "MP4 upload"),
  });
  return updateState(state, { publication });
}

function missingPublicationFailure(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  failure: string | undefined,
): string | undefined {
  if (failure !== undefined || config.upload === undefined || state.publication !== undefined) {
    return failure;
  }
  return "Recording finished without an uploaded MP4";
}

async function finalizeMediaIfNeeded(
  config: NormalizedSessionConfig,
  state: RecordingSessionState,
  control: FinalizationProcessControl,
  timeout: FinalizationTimeout,
  captureStopped: boolean,
): Promise<FinalizationResult> {
  if (!captureStopped || state.publication !== undefined) {
    const failure = missingPublicationFailure(config, state, undefined);
    return { state, ...(failure === undefined ? {} : { failure }) };
  }
  if (!(await fileIsNonempty(state.playlistPath))) {
    const playlistFailure = control.captureStarted
      ? "Recording supervisor stopped without producing an HLS playlist"
      : undefined;
    const failure = missingPublicationFailure(config, state, playlistFailure);
    return { state, ...(failure === undefined ? {} : { failure }) };
  }
  state = await updateState(state, { phase: "finalizing_mp4" });
  await remuxAndVerifyMp4(config, state, timeout);
  state = await publishFinalMp4IfConfigured(config, state, timeout);
  const failure = missingPublicationFailure(config, state, undefined);
  return { state, ...(failure === undefined ? {} : { failure }) };
}

async function attemptCleanup(
  label: string,
  timeoutMs: number,
  operation: (timeoutMs: number) => Promise<void>,
): Promise<string | undefined> {
  try {
    await operation(timeoutMs);
    return undefined;
  } catch (error) {
    return `${label}: ${errorMessage(error)}`;
  }
}

async function cleanupSessionResources(
  state: RecordingSessionState,
  control: FinalizationProcessControl,
  note: (message: string) => void,
): Promise<RecordingSessionState> {
  try {
    state = await updateState(state, { phase: "cleaning_up" });
  } catch (error) {
    note(`recording state cleanup: ${errorMessage(error)}`);
  }
  const windowManager = await attemptCleanup("openbox cleanup", 3_000, control.stopWindowManager);
  if (windowManager !== undefined) note(windowManager);
  const display = await attemptCleanup("Xvfb cleanup", 3_000, control.stopDisplay);
  if (display !== undefined) note(display);
  await unlink(state.xauthorityPath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return;
    note(`Xauthority cleanup: ${errorMessage(error)}`);
  });
  return state;
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
  const note = (message: string): void => {
    warnings.push(message);
    failure ??= message;
  };

  try {
    state = await closeBrowserIfNeeded(config, state, timeout, note);
    state = await updateState(state, { phase: "stopping_capture" });
    let captureStopped = true;
    if (control.captureStarted) {
      const message = await attemptCleanup(
        "FFmpeg cleanup",
        timeout(config.stopTimeoutMs, "FFmpeg cleanup"),
        control.stopCapture,
      );
      if (message !== undefined) {
        note(message);
        captureStopped = false;
      }
    }
    const media = await finalizeMediaIfNeeded(config, state, control, timeout, captureStopped);
    state = media.state;
    if (media.failure !== undefined) note(media.failure);
  } catch (error) {
    note(errorMessage(error));
  }

  state = await cleanupSessionResources(state, control, note);
  return { state, ...(failure === undefined ? {} : { failure }) };
}

function managedProcessControl(processes: {
  readonly xvfb?: ManagedProcess;
  readonly openbox?: ManagedProcess;
  readonly ffmpeg?: ManagedProcess;
}): FinalizationProcessControl {
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

async function recoverSession(
  runtimeDirectory: string,
  deadline: number,
): Promise<RecordingSessionState> {
  let state = await readState(runtimeDirectory);
  if (state === null) throw new Error("Recording state disappeared during stop");
  const config = await readSessionConfig(runtimeDirectory);
  if (await isRecoveredTerminal(state, config)) return state;
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
    await releaseDisplayLock(state.displayLockPath, state.supervisor);
  }
  if (failure === undefined) {
    const { failure: _failure, warnings: _warnings, ...cleanState } = state;
    state = cleanState;
  }
  const now = new Date().toISOString();
  return updateState(state, {
    phase: failure === undefined ? "finished" : "failed",
    ...(failure === undefined ? {} : { failure }),
    ...(warnings.length === 0 ? {} : { warnings }),
    updatedAt: now,
    finishedAt: now,
  });
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

function isMatchingVideoProfile(
  video: Record<string, unknown>,
  container: Record<string, unknown>,
  config: NormalizedSessionConfig,
): boolean {
  const measuredFps = parseFrameRate(video.avg_frame_rate);
  const frames = isString(video.nb_frames) ? Number(video.nb_frames) : Number.NaN;
  const duration = isString(container.duration) ? Number(container.duration) : Number.NaN;
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

function assertMp4MatchesProfile(
  parsed: Record<string, unknown>,
  config: NormalizedSessionConfig,
): void {
  const stream =
    Array.isArray(parsed.streams) && parsed.streams.length === 1 ? parsed.streams[0] : undefined;
  const format = parsed.format;
  if (
    typeof stream !== "object" ||
    stream === null ||
    typeof format !== "object" ||
    format === null
  ) {
    throw new Error("Final MP4 is missing its video stream or duration");
  }
  if (
    !isMatchingVideoProfile(
      stream as Record<string, unknown>,
      format as Record<string, unknown>,
      config,
    )
  ) {
    throw new Error("Final MP4 does not match the requested H.264/yuv420p geometry and FPS");
  }
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
  assertMp4MatchesProfile(parseObject(probe.stdout, "ffprobe output"), config);
  const decode = await runExact(
    [config.executables.ffmpeg, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "null", "-"],
    { timeoutMs },
  );
  requireSuccess("final MP4 decode", decode);
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

function sessionPaths(runtimeDirectory: string): {
  readonly captureDirectory: string;
  readonly playlistPath: string;
  readonly segmentPattern: string;
  readonly finalMp4Path: string;
  readonly xauthorityPath: string;
  readonly supervisorLogPath: string;
  readonly xvfbLogPath: string;
  readonly openboxLogPath: string;
  readonly ffmpegLogPath: string;
  readonly ffmpegProgressPath: string;
} {
  const captureDirectory = join(runtimeDirectory, "capture");
  return {
    captureDirectory,
    playlistPath: join(captureDirectory, "index.m3u8"),
    segmentPattern: join(captureDirectory, "segment-%06d.ts"),
    finalMp4Path: join(runtimeDirectory, "recording.mp4"),
    xauthorityPath: join(runtimeDirectory, "Xauthority"),
    supervisorLogPath: join(runtimeDirectory, SUPERVISOR_LOG_NAME),
    xvfbLogPath: join(runtimeDirectory, "xvfb.log"),
    openboxLogPath: join(runtimeDirectory, "openbox.log"),
    ffmpegLogPath: join(runtimeDirectory, "ffmpeg.log"),
    ffmpegProgressPath: join(runtimeDirectory, "ffmpeg-progress.log"),
  };
}

function namedExecutable(
  source: RecordingExecutables | undefined,
  name: keyof RecordingExecutables,
  fallback: string,
): string {
  const value = source?.[name];
  return executable(value === undefined ? fallback : value);
}

function normalizeExecutables(
  source: RecordingExecutables | undefined,
): Required<RecordingExecutables> {
  return {
    agentBrowser: namedExecutable(source, "agentBrowser", "agent-browser"),
    ffmpeg: namedExecutable(source, "ffmpeg", "ffmpeg"),
    ffprobe: namedExecutable(source, "ffprobe", "ffprobe"),
    mcookie: namedExecutable(source, "mcookie", "mcookie"),
    openbox: namedExecutable(source, "openbox", "openbox"),
    xauth: namedExecutable(source, "xauth", "xauth"),
    xdpyinfo: namedExecutable(source, "xdpyinfo", "xdpyinfo"),
    xprop: namedExecutable(source, "xprop", "xprop"),
    xvfb: namedExecutable(source, "xvfb", "Xvfb"),
  };
}

function optionalBoundedInteger(
  value: number | undefined,
  label: string,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = positiveInteger(value, label);
  if (parsed > maximum) throw new Error(`${label} must not exceed ${maximum}`);
  return parsed;
}

function normalizeOptions(options: StartSessionOptions): NormalizedSessionConfig {
  const runtimeDirectory = validateRuntimeDirectory(options.runtimeDirectory);
  const width = positiveInteger(options.width, "width");
  const height = positiveInteger(options.height, "height");
  if (width > 16_384 || height > 16_384) throw new Error("Capture dimensions are too large");
  if (options.fps !== 30 && options.fps !== 60) throw new Error("fps must be 30 or 60");
  const displayNumber = optionalBoundedInteger(options.displayNumber, "displayNumber", 65_535);
  return {
    id: validateRecordingId(options.recordingId ?? randomUUID()),
    runtimeDirectory,
    width,
    height,
    fps: options.fps,
    segmentDurationSeconds: positiveInteger(
      options.segmentDurationSeconds ?? 10,
      "segmentDurationSeconds",
    ),
    initialUrl: validateInitialUrl(options.initialUrl ?? "about:blank"),
    ...(displayNumber === undefined ? {} : { displayNumber }),
    startupTimeoutMs: positiveInteger(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    ),
    stopTimeoutMs: positiveInteger(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "stopTimeoutMs",
    ),
    executables: normalizeExecutables(options.executables),
    ...(options.upload === undefined ? {} : { upload: normalizeUpload(options.upload) }),
  };
}

function validateRecordingId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error("recordingId must be a UUID");
  }
  return value;
}

function assertCompatibleSession(
  state: RecordingSessionState,
  requested: NormalizedSessionConfig,
): void {
  if (
    state.width !== requested.width ||
    state.height !== requested.height ||
    state.fps !== requested.fps ||
    state.segmentDurationSeconds !== requested.segmentDurationSeconds ||
    (requested.displayNumber !== undefined && state.display !== `:${requested.displayNumber}`)
  ) {
    throw new Error("runtimeDirectory already belongs to a different recording configuration");
  }
}

function normalizeUpload(options: RecordingUploadOptions): RecordingUploadOptions {
  assertUploadsKey(options.key);
  if (options.workspace !== undefined) assertUploadsWorkspace(options.workspace);
  return {
    key: options.key,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.executable === undefined ? {} : { executable: executable(options.executable) }),
  };
}

function validateRuntimeDirectory(source: string): string {
  if (!isAbsolute(source) || source.includes("\0")) {
    throw new Error("runtimeDirectory must be an absolute path");
  }
  const directory = resolve(source);
  if (directory === "/" || directory === resolve("/tmp") || directory === resolve("/var/tmp")) {
    throw new Error("runtimeDirectory must name a dedicated directory");
  }
  return directory;
}

function validateInitialUrl(source: string): string {
  if (source === "about:blank") return source;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("initialUrl must be an absolute URL");
  }
  if (!new Set(["http:", "https:", "file:"]).has(url.protocol)) {
    throw new Error("initialUrl must use http, https, file, or about:blank");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("initialUrl must not contain credentials");
  }
  return url.toString();
}

function executable(source: string): string {
  if (source.length === 0 || source.includes("\0")) throw new Error("Executable must not be empty");
  return source;
}

async function ensureRuntimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function waitForState(
  runtimeDirectory: string,
  timeoutMs: number,
): Promise<RecordingSessionState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(runtimeDirectory);
    if (state !== null) return waitForStarted(state, Math.max(1, deadline - Date.now()));
    await delay(50);
  }
  throw new Error(`Recording supervisor did not create state within ${timeoutMs} ms`);
}

async function waitForStarted(
  initial: RecordingSessionState,
  timeoutMs: number,
): Promise<RecordingSessionState> {
  if (initial.phase === "recording" || !isActive(initial.phase)) return initial;
  const deadline = Date.now() + timeoutMs;
  let state = initial;
  while (Date.now() < deadline) {
    if (state.phase === "recording" || !isActive(state.phase)) return state;
    if (!(await identityIsAlive(state.supervisor))) {
      const now = new Date().toISOString();
      const failed = await updateState(state, {
        phase: "failed",
        failure: "Recording supervisor exited during startup",
        updatedAt: now,
        finishedAt: now,
      });
      return failed;
    }
    await delay(50);
    state = (await readState(state.runtimeDirectory)) ?? state;
  }
  throw new Error(`Recording startup did not finish within ${timeoutMs} ms`);
}

async function waitForTerminalState(
  runtimeDirectory: string,
  timeoutMs: number,
  returnWhenSupervisorExits = true,
): Promise<RecordingSessionStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(runtimeDirectory);
    if (
      state !== null &&
      !isActive(state.phase) &&
      !(await identityIsAlive(state.supervisor)) &&
      !(await hasLiveOwnedProcess(state)) &&
      !(await hasOwnedDisplayLock(state))
    ) {
      return {
        exists: true,
        supervisorAlive: await identityIsAlive(state.supervisor),
        state,
        capture: await readCaptureProgress(sessionPaths(runtimeDirectory).ffmpegProgressPath),
      };
    }
    if (
      returnWhenSupervisorExits &&
      state !== null &&
      (await identityIsAlive(state.supervisor)) === false
    ) {
      return null;
    }
    await delay(100);
  }
  return null;
}

async function readState(runtimeDirectory: string): Promise<RecordingSessionState | null> {
  const path = join(runtimeDirectory, STATE_NAME);
  let source: string;
  try {
    source = await readBoundedText(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  return parseState(source, runtimeDirectory);
}

async function readSessionConfig(runtimeDirectory: string): Promise<NormalizedSessionConfig> {
  const configPath = join(runtimeDirectory, CONFIG_NAME);
  return parseConfig(await readBoundedText(configPath), configPath);
}

async function writeState(state: RecordingSessionState): Promise<void> {
  const path = join(state.runtimeDirectory, STATE_NAME);
  const temporary = join(state.runtimeDirectory, `.${STATE_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function updateState(
  state: RecordingSessionState,
  patch: Partial<RecordingSessionState>,
): Promise<RecordingSessionState> {
  const updatedAt = patch.updatedAt ?? new Date().toISOString();
  const phaseHistory =
    patch.phase !== undefined && patch.phase !== state.phase
      ? [...state.phaseHistory, { phase: patch.phase, at: updatedAt }]
      : state.phaseHistory;
  const next = { ...state, ...patch, phaseHistory, updatedAt };
  await writeState(next);
  return next;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasStateCore(parsed: Record<string, unknown>, runtimeDirectory: string): boolean {
  return (
    parsed.schemaVersion === SESSION_SCHEMA_VERSION &&
    parsed.runtimeDirectory === runtimeDirectory &&
    isPhase(parsed.phase) &&
    isIdentity(parsed.supervisor) &&
    isPositiveInteger(parsed.width) &&
    isPositiveInteger(parsed.height) &&
    (parsed.fps === 30 || parsed.fps === 60) &&
    isPositiveInteger(parsed.segmentDurationSeconds) &&
    isString(parsed.startedAt) &&
    isString(parsed.updatedAt)
  );
}

function hasStateStrings(parsed: Record<string, unknown>): boolean {
  return (
    isString(parsed.id) &&
    isString(parsed.display) &&
    isString(parsed.xauthorityPath) &&
    isString(parsed.displayLockPath) &&
    isString(parsed.playlistPath) &&
    isString(parsed.segmentPattern) &&
    isString(parsed.finalMp4Path) &&
    isString(parsed.supervisorLogPath) &&
    isString(parsed.agentBrowserSession) &&
    isString(parsed.agentBrowserNamespace)
  );
}

function hasPhaseHistory(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return isPhase(record.phase) && isString(record.at);
    })
  );
}

function assertStatePathOwnership(parsed: Record<string, unknown>, runtimeDirectory: string): void {
  for (const path of [
    parsed.xauthorityPath,
    parsed.playlistPath,
    parsed.segmentPattern,
    parsed.finalMp4Path,
    parsed.supervisorLogPath,
  ]) {
    assertWithin(runtimeDirectory, path as string);
  }
  if (
    !/^:\d+$/u.test(parsed.display as string) ||
    !/^\/tmp\/sandbox-video-display-\d+\.lock$/u.test(parsed.displayLockPath as string)
  ) {
    throw new Error("Invalid recording display ownership state");
  }
}

function assertOwnedProcessFields(parsed: Record<string, unknown>): void {
  for (const process of [parsed.xvfb, parsed.openbox, parsed.ffmpeg]) {
    if (process !== undefined && !isIdentity(process)) {
      throw new Error("Invalid owned process state");
    }
  }
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined && !isString(value)) throw new Error(label);
}

function assertOptionalStateFields(parsed: Record<string, unknown>): void {
  if (parsed.failure !== undefined && !isString(parsed.failure)) {
    throw new Error("Invalid recording failure state");
  }
  if (parsed.warnings !== undefined && !isStringArray(parsed.warnings)) {
    throw new Error("Invalid recording warning state");
  }
  assertOptionalTimestamp(parsed.finishedAt, "Invalid recording completion state");
  assertOptionalTimestamp(parsed.browserClosedAt, "Invalid browser cleanup state");
  assertOptionalTimestamp(parsed.browserStartAttemptedAt, "Invalid browser startup state");
  if (parsed.publication !== undefined && !isPublication(parsed.publication)) {
    throw new Error("Invalid recording publication state");
  }
}

function parseState(source: string, runtimeDirectory: string): RecordingSessionState {
  const parsed = parseObject(source, "recording state");
  if (
    !hasStateCore(parsed, runtimeDirectory) ||
    !hasStateStrings(parsed) ||
    !hasPhaseHistory(parsed.phaseHistory)
  ) {
    throw new Error("Invalid recording state");
  }
  assertStatePathOwnership(parsed, runtimeDirectory);
  assertOwnedProcessFields(parsed);
  assertOptionalStateFields(parsed);
  return parsed as unknown as RecordingSessionState;
}

function isRequiredConfigShape(parsed: Record<string, unknown>): boolean {
  return (
    isString(parsed.id) &&
    isString(parsed.runtimeDirectory) &&
    isPositiveInteger(parsed.width) &&
    isPositiveInteger(parsed.height) &&
    (parsed.fps === 30 || parsed.fps === 60) &&
    isPositiveInteger(parsed.segmentDurationSeconds) &&
    isString(parsed.initialUrl) &&
    isPositiveInteger(parsed.startupTimeoutMs) &&
    isPositiveInteger(parsed.stopTimeoutMs) &&
    isExecutableRecord(parsed.executables)
  );
}

function optionalConfigDisplayNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isPositiveInteger(value) || value > 65_535) {
    throw new Error("Invalid recording display number");
  }
  return value;
}

function parseConfigExecutables(
  record: Required<RecordingExecutables>,
): Required<RecordingExecutables> {
  return {
    agentBrowser: executable(record.agentBrowser),
    ffmpeg: executable(record.ffmpeg),
    ffprobe: executable(record.ffprobe),
    mcookie: executable(record.mcookie),
    openbox: executable(record.openbox),
    xauth: executable(record.xauth),
    xdpyinfo: executable(record.xdpyinfo),
    xprop: executable(record.xprop),
    xvfb: executable(record.xvfb),
  };
}

function parseConfig(source: string, configPath: string): NormalizedSessionConfig {
  const parsed = parseObject(source, "recording config");
  if (!isRequiredConfigShape(parsed)) throw new Error("Invalid recording config");
  const runtimeDirectory = validateRuntimeDirectory(parsed.runtimeDirectory as string);
  if (join(runtimeDirectory, CONFIG_NAME) !== configPath) {
    throw new Error("Recording config is outside its runtime directory");
  }
  if (parsed.upload !== undefined && !isUploadConfig(parsed.upload)) {
    throw new Error("Invalid recording upload config");
  }
  validateRecordingId(parsed.id as string);
  const displayNumber = optionalConfigDisplayNumber(parsed.displayNumber);
  const upload = parsed.upload === undefined ? undefined : normalizeUpload(parsed.upload);
  return {
    id: parsed.id as string,
    runtimeDirectory,
    width: parsed.width as number,
    height: parsed.height as number,
    fps: parsed.fps as 30 | 60,
    segmentDurationSeconds: parsed.segmentDurationSeconds as number,
    initialUrl: validateInitialUrl(parsed.initialUrl as string),
    ...(displayNumber === undefined ? {} : { displayNumber }),
    startupTimeoutMs: parsed.startupTimeoutMs as number,
    stopTimeoutMs: parsed.stopTimeoutMs as number,
    executables: parseConfigExecutables(parsed.executables as Required<RecordingExecutables>),
    ...(upload === undefined ? {} : { upload }),
  };
}

function parseObject(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} payload`);
  }
  return parsed as Record<string, unknown>;
}

async function readBoundedText(path: string): Promise<string> {
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source) > 1_000_000) throw new Error(`File is too large: ${path}`);
  return source;
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
    const stale = await readDisplayOwner(lockPath);
    if (stale !== null && !(await identityIsAlive(stale))) {
      const removed = await unlink(lockPath).then(
        () => true,
        () => false,
      );
      if (removed) offset -= 1;
    }
  }
  throw new Error("No recording-owned X display is available");
}

async function readDisplayOwner(path: string): Promise<OwnedProcessIdentity | null> {
  try {
    const parsed = parseObject(await readBoundedText(path), "display lock");
    return isIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function acquireRecoveryLock(path: string, owner: OwnedProcessIdentity): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await tryCreateOwnedLock(path, owner)) return true;
    const current = await readDisplayOwner(path);
    if (current !== null && (await identityIsAlive(current))) return false;
    await unlink(path).catch((unlinkError: unknown) => {
      if (!hasCode(unlinkError, "ENOENT")) throw unlinkError;
    });
  }
  return false;
}

async function tryCreateOwnedLock(path: string, owner: OwnedProcessIdentity): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.candidate`;
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function releaseDisplayLock(path: string, owner: OwnedProcessIdentity): Promise<void> {
  const current = await readDisplayOwner(path);
  if (current !== null && sameIdentity(current, owner)) await unlink(path).catch(() => undefined);
}

async function spawnManaged(
  argv: readonly [string, ...string[]],
  environment: NodeJS.ProcessEnv,
  logPath: string,
): Promise<ManagedProcess> {
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(argv[0], argv.slice(1), {
      env: environment,
      shell: false,
      stdio: ["ignore", log.fd, log.fd],
    });
    await waitForSpawn(child);
    if (child.pid === undefined) throw new Error(`${argv[0]} did not report a PID`);
    const identity = await processIdentity(child.pid, argv[0]);
    const exit = observeExit(child);
    return { child, identity, exit };
  } finally {
    await log.close();
  }
}

function observeExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function unexpectedExit(
  label: string,
  process: ManagedProcess,
): Promise<{ readonly type: "exit"; readonly message: string }> {
  const result = await process.exit;
  return {
    type: "exit",
    message: `${label} exited unexpectedly (${formatExit(result)})`,
  };
}

async function stopManaged(
  process: ManagedProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill(signal);
  if ((await settleWithin(process.exit, timeoutMs)) !== null) return;
  process.child.kill("SIGKILL");
  if ((await settleWithin(process.exit, 2_000)) === null) {
    throw new Error(`${process.identity.executable} did not exit after SIGKILL`);
  }
}

async function stopOwned(
  process: OwnedProcessIdentity,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (!(await identityIsAlive(process))) return;
  await signalOwned(process, signal);
  if (await waitForIdentityExit(process, timeoutMs)) return;
  await signalOwned(process, "SIGKILL");
  if (!(await waitForIdentityExit(process, 2_000))) {
    throw new Error(`${process.executable} did not exit after SIGKILL`);
  }
}

async function signalOwned(identity: OwnedProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  if (!(await identityIsAlive(identity))) return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}

async function hasLiveOwnedProcess(state: RecordingSessionState): Promise<boolean> {
  for (const identity of [state.ffmpeg, state.openbox, state.xvfb]) {
    if (identity !== undefined && (await identityIsAlive(identity))) return true;
  }
  return false;
}

async function hasOwnedDisplayLock(state: RecordingSessionState): Promise<boolean> {
  const owner = await readDisplayOwner(state.displayLockPath);
  return owner !== null && sameIdentity(owner, state.supervisor);
}

function browserCleanupRequired(state: RecordingSessionState): boolean {
  return (
    state.browserStartAttemptedAt !== undefined ||
    state.phaseHistory.some((entry) => entry.phase === "recording")
  );
}

function browserCleanupComplete(state: RecordingSessionState): boolean {
  return !browserCleanupRequired(state) || state.browserClosedAt !== undefined;
}

function publicationComplete(
  state: RecordingSessionState,
  config: NormalizedSessionConfig,
): boolean {
  return config.upload === undefined || state.publication !== undefined;
}

async function failStopAtDeadline(
  runtimeDirectory: string,
  failure: string,
): Promise<RecordingSessionStatus> {
  let state = await readState(runtimeDirectory);
  if (state === null) return { exists: false, runtimeDirectory };
  const warnings: string[] = [];
  for (const owned of [state.ffmpeg, state.openbox, state.xvfb]) {
    if (owned === undefined) continue;
    await signalOwned(owned, "SIGKILL").catch((error: unknown) => {
      warnings.push(`${owned.executable} emergency cleanup: ${errorMessage(error)}`);
    });
  }
  const now = new Date().toISOString();
  state = await updateState(state, {
    phase: "failed",
    failure,
    ...(warnings.length === 0 ? {} : { warnings }),
    updatedAt: now,
    finishedAt: now,
  });
  return {
    exists: true,
    supervisorAlive: await identityIsAlive(state.supervisor),
    state,
    capture: await readCaptureProgress(sessionPaths(runtimeDirectory).ffmpegProgressPath),
  };
}

async function waitForIdentityExit(
  identity: OwnedProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await identityIsAlive(identity))) return true;
    await delay(50);
  }
  return !(await identityIsAlive(identity));
}

async function currentIdentity(): Promise<OwnedProcessIdentity> {
  return processIdentity(process.pid, process.execPath);
}

async function processIdentity(pid: number, executableName: string): Promise<OwnedProcessIdentity> {
  const startTimeTicks = await readProcessStartTime(pid);
  return { pid, startTimeTicks, executable: executableName };
}

async function identityIsAlive(identity: OwnedProcessIdentity): Promise<boolean> {
  try {
    return (await readProcessStartTime(identity.pid)) === identity.startTimeTicks;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

async function readProcessStartTime(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process PID");
  const source = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = source.lastIndexOf(")");
  if (closing < 0) throw new Error(`Invalid /proc stat for PID ${pid}`);
  const fields = source
    .slice(closing + 1)
    .trim()
    .split(/\s+/u);
  const startTimeTicks = fields[19];
  if (startTimeTicks === undefined || !/^\d+$/u.test(startTimeTicks)) {
    throw new Error(`Invalid process start time for PID ${pid}`);
  }
  return startTimeTicks;
}

function sameIdentity(left: OwnedProcessIdentity, right: OwnedProcessIdentity): boolean {
  return left.pid === right.pid && left.startTimeTicks === right.startTimeTicks;
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
      const progress = await readBoundedText(progressPath);
      if (/^frame=[1-9]\d*$/mu.test(progress)) return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    await delay(50);
  }
  throw new Error("FFmpeg capture readiness timed out");
}

async function readCaptureProgress(progressPath: string): Promise<RecordingCaptureProgress> {
  let source: string;
  try {
    source = await readBoundedText(progressPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { frame: 0, outputTimeMs: 0 };
    throw error;
  }
  let frame = 0;
  let outputTimeMs = 0;
  for (const line of source.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1);
    if (key === "frame") frame = parseProgressInteger(raw, frame);
    if (key === "out_time_ms") {
      const microseconds = parseProgressInteger(raw, outputTimeMs * 1_000);
      outputTimeMs = Math.floor(microseconds / 1_000);
    }
    if (key === "out_time_us") {
      const microseconds = parseProgressInteger(raw, outputTimeMs * 1_000);
      outputTimeMs = Math.floor(microseconds / 1_000);
    }
  }
  return { frame, outputTimeMs };
}

function parseProgressInteger(value: string, fallback: number): number {
  if (!/^\d+$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
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

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fileIsNonempty(path: string): Promise<boolean> {
  try {
    const value = await stat(path);
    return value.isFile() && value.size > 0;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function assertWithin(directory: string, path: string): void {
  const normalized = resolve(path);
  if (normalized !== directory && !normalized.startsWith(`${directory}${sep}`)) {
    throw new Error("Recording state path escapes its runtime directory");
  }
}

function isActive(phase: RecordingSessionPhase): boolean {
  return phase !== "finished" && phase !== "failed";
}

function isPhase(value: unknown): value is RecordingSessionPhase {
  return new Set([
    "starting",
    "recording",
    "closing_browser",
    "stopping_capture",
    "finalizing_mp4",
    "uploading_mp4",
    "cleaning_up",
    "finished",
    "failed",
  ]).has(value as string);
}

function isIdentity(value: unknown): value is OwnedProcessIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    isPositiveInteger((value as Record<string, unknown>).pid) &&
    typeof (value as Record<string, unknown>).startTimeTicks === "string" &&
    /^\d+$/u.test((value as Record<string, unknown>).startTimeTicks as string) &&
    typeof (value as Record<string, unknown>).executable === "string" &&
    ((value as Record<string, unknown>).executable as string).length > 0 &&
    !((value as Record<string, unknown>).executable as string).includes("\0")
  );
}

function isPublication(value: unknown): value is UploadsPublication {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.url === "string" &&
    record.contentType === "video/mp4" &&
    isPositiveInteger(record.sizeBytes)
  );
}

function isExecutableRecord(value: unknown): value is Required<RecordingExecutables> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return [
    "agentBrowser",
    "ffmpeg",
    "ffprobe",
    "mcookie",
    "openbox",
    "xauth",
    "xdpyinfo",
    "xprop",
    "xvfb",
  ].every((name) => typeof record[name] === "string" && (record[name] as string).length > 0);
}

function isUploadConfig(value: unknown): value is RecordingUploadOptions {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    (record.workspace === undefined || typeof record.workspace === "string") &&
    (record.executable === undefined || typeof record.executable === "string")
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function remainingTimeout(deadline: number, maximum: number, label: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded the stop timeout`);
  return Math.max(1, Math.min(maximum, remaining));
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExit(result: ProcessExit): string {
  if (result.error !== undefined) return result.error;
  if (result.exitCode !== null) return `exit ${result.exitCode}`;
  return result.signal ?? "unknown termination";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[2] === SUPERVISOR_MODE) {
  const configPath = process.argv[3];
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

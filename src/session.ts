import { spawn } from "node:child_process";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireRecoveryLock,
  currentIdentity,
  identityIsAlive,
  processIdentity,
  releaseOwnedLock,
  signalOwned,
  stopOwned,
  waitForIdentityExit,
  waitForSpawn,
  type OwnedProcessIdentity,
} from "./owned.js";
import {
  assertCompatibleConfig,
  assertCompatibleSession,
  CONFIG_NAME,
  DEFAULT_STARTUP_TIMEOUT_MS,
  ensureRuntimeDirectory,
  finishState,
  hasLiveOwnedProcess,
  hasOwnedDisplayLock,
  isActive,
  normalizeOptions,
  readCaptureProgress,
  readSessionConfig,
  readState,
  RECOVERY_LOCK_NAME,
  sessionPaths,
  SUPERVISOR_LOG_NAME,
  validateRuntimeDirectory,
  type NormalizedSessionConfig,
  type RecordingSessionState,
  type RecordingSessionStatus,
  type StartSessionOptions,
  type StopSessionOptions,
} from "./state.js";
import { isFullyReleased, recoverSession } from "./supervisor.js";
import { delay, errorMessage, hasCode, positiveInteger, remainingTimeout } from "./util.js";

export { RECORDING_STOP_PHASES } from "./state.js";
export type {
  RecordingCaptureProgress,
  RecordingCapturePolicy,
  RecordingExecutables,
  RecordingMedia,
  RecordingSessionPhase,
  RecordingSessionState,
  RecordingSessionStatus,
  RecordingUploadOptions,
  StartSessionOptions,
  StopSessionOptions,
} from "./state.js";
export type { OwnedProcessIdentity } from "./owned.js";

const DEFAULT_FINALIZATION_TIMEOUT_MS = 10 * 60_000;

/** Start one recording, or return the durable result of an earlier call for this directory. */
export async function startSession(options: StartSessionOptions): Promise<RecordingSessionState> {
  const config = normalizeOptions(options);
  await ensureRuntimeDirectory(config.runtimeDirectory);
  const existing = await readState(config.runtimeDirectory);
  if (existing !== null) {
    await assertCompatibleAttach(existing, config);
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
    return attachToExistingClaim(config, configPath);
  }

  const logPath = join(config.runtimeDirectory, SUPERVISOR_LOG_NAME);
  const log = await open(logPath, "a", 0o600);
  let supervisor: OwnedProcessIdentity | null = null;
  try {
    const supervisorModulePath = fileURLToPath(new URL("./supervisor.js", import.meta.url));
    const child = spawn(process.execPath, [supervisorModulePath, configPath], {
      detached: true,
      env: process.env,
      shell: false,
      stdio: ["ignore", log.fd, log.fd],
    });
    await waitForSpawn(child);
    if (child.pid !== undefined) {
      supervisor = await processIdentity(child.pid, process.execPath).catch(() => null);
    }
    child.unref();
  } catch (error) {
    await unlink(configPath).catch(() => undefined);
    throw error;
  } finally {
    await log.close();
  }
  try {
    const state = await waitForState(config.runtimeDirectory, config.startupTimeoutMs);
    assertCompatibleSession(state, config);
    return state;
  } catch (error) {
    const late = await lateStartedState(config);
    if (late !== null) return late;
    await reapFailedStartup(config, configPath, supervisor);
    throw error;
  }
}

/** Attach checks: state geometry plus the stored claim's URL and upload target. */
async function assertCompatibleAttach(
  state: RecordingSessionState,
  config: NormalizedSessionConfig,
): Promise<void> {
  assertCompatibleSession(state, config);
  const stored = await readSessionConfig(state.runtimeDirectory).catch(() => null);
  if (stored !== null) assertCompatibleConfig(stored, config);
}

async function attachToExistingClaim(
  config: NormalizedSessionConfig,
  configPath: string,
): Promise<RecordingSessionState> {
  try {
    const state = await waitForState(config.runtimeDirectory, config.startupTimeoutMs);
    await assertCompatibleAttach(state, config);
    return state;
  } catch (error) {
    await releaseAbandonedClaim(config.runtimeDirectory, configPath);
    throw error;
  }
}

/**
 * A startup that finished just after the caller's deadline is a healthy
 * recording, not a failure: return it instead of reaping it.
 */
async function lateStartedState(
  config: NormalizedSessionConfig,
): Promise<RecordingSessionState | null> {
  const state = await readState(config.runtimeDirectory).catch(() => null);
  if (state === null || state.phase !== "recording") return null;
  assertCompatibleSession(state, config);
  return state;
}

/**
 * Free a runtime directory wedged by another caller's abandoned claim: the
 * config exists, no state ever appeared, and the claim's own startup window
 * has fully elapsed. A live supervisor writes state within seconds of
 * spawning, so an expired claim proves its supervisor died before recording.
 */
async function releaseAbandonedClaim(runtimeDirectory: string, configPath: string): Promise<void> {
  const state = await readState(runtimeDirectory).catch(() => null);
  if (state !== null) return;
  // A corrupt claim (stored === null) can never produce state, but is still
  // only removed once the floored window elapses, so a transient read error
  // or a tiny configured timeout cannot delete a live caller's claim.
  const stored = await readSessionConfig(runtimeDirectory).catch(() => null);
  const claim = await stat(configPath).catch(() => null);
  if (claim === null) return;
  const window = Math.max(stored?.startupTimeoutMs ?? 0, DEFAULT_STARTUP_TIMEOUT_MS) + 5_000;
  if (Date.now() - claim.mtimeMs > window) {
    await unlink(configPath).catch(() => undefined);
  }
}

/**
 * A startup that timed out must not leak a detached 60 FPS encoder: ask the
 * supervisor to shut down (its signal handler runs full finalization), and
 * unlink the config claim when the supervisor died before writing any state
 * so the runtime directory stays usable for a retry.
 */
async function reapFailedStartup(
  config: NormalizedSessionConfig,
  configPath: string,
  supervisor: OwnedProcessIdentity | null,
): Promise<void> {
  if (supervisor !== null) {
    await stopOwned(supervisor, "SIGTERM", config.stopTimeoutMs);
  }
  // Confirmed dead before reading: a dead supervisor cannot write state after
  // this point, so a missing state file proves the config claim is abandoned.
  const state = await readState(config.runtimeDirectory).catch(() => null);
  if (state === null) {
    await unlink(configPath).catch(() => undefined);
    return;
  }
  await stopSession({
    runtimeDirectory: config.runtimeDirectory,
    timeoutMs: config.stopTimeoutMs,
  });
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
  if (await isFullyReleased(first.state, config)) return first;

  if (isActive(first.state.phase) && first.supervisorAlive) {
    const terminal = await terminateSupervisor(
      first.state.supervisor,
      directory,
      deadline,
      timeoutMs,
    );
    if (terminal !== null) return terminal;
  } else if (first.supervisorAlive) {
    await waitForIdentityExit(first.state.supervisor, remainingTimeout(deadline, 2_000, "stop"));
  }
  return recoverUnderLock(directory, deadline);
}

async function terminateSupervisor(
  supervisor: OwnedProcessIdentity,
  directory: string,
  deadline: number,
  timeoutMs: number,
): Promise<RecordingSessionStatus | null> {
  await signalOwned(supervisor, "SIGTERM");
  const terminal = await waitForTerminalState(
    directory,
    remainingTimeout(deadline, timeoutMs, "stop"),
  );
  if (terminal !== null) return terminal;
  await signalOwned(supervisor, "SIGKILL");
  if (Date.now() >= deadline) {
    return failStopAtDeadline(directory, "Recording stop exceeded its timeout");
  }
  await waitForIdentityExit(supervisor, remainingTimeout(deadline, 2_000, "stop"));
  if (Date.now() >= deadline) {
    return failStopAtDeadline(directory, "Recording stop exceeded its timeout");
  }
  return null;
}

async function recoverUnderLock(
  directory: string,
  deadline: number,
): Promise<RecordingSessionStatus> {
  const recoveryOwner = await currentIdentity();
  const recoveryLockPath = join(directory, RECOVERY_LOCK_NAME);
  while (!(await acquireRecoveryLock(recoveryLockPath, recoveryOwner))) {
    const terminal = await waitForTerminalState(
      directory,
      remainingTimeout(deadline, 250, "concurrent stop"),
      false,
    );
    if (terminal !== null) return terminal;
  }
  let recovered: RecordingSessionState;
  try {
    recovered = await recoverSession(directory, deadline);
  } catch (error) {
    const current = await readState(directory);
    if (current === null) throw error;
    recovered = await finishState(current, errorMessage(error), []);
  } finally {
    await releaseOwnedLock(recoveryLockPath, recoveryOwner);
  }
  return {
    exists: true,
    supervisorAlive: false,
    state: recovered,
    capture: await readCaptureProgress(sessionPaths(directory).ffmpegProgressPath),
  };
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
  state = await finishState(state, failure, warnings);
  return {
    exists: true,
    supervisorAlive: await identityIsAlive(state.supervisor),
    state,
    capture: await readCaptureProgress(sessionPaths(runtimeDirectory).ffmpegProgressPath),
  };
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
      const fresh = (await readState(state.runtimeDirectory)) ?? state;
      if (fresh.phase === "recording" || !isActive(fresh.phase)) return fresh;
      return finishState(fresh, "Recording supervisor exited during startup", []);
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
        supervisorAlive: false,
        state,
        capture: await readCaptureProgress(sessionPaths(runtimeDirectory).ffmpegProgressPath),
      };
    }
    if (returnWhenSupervisorExits && state !== null && !(await identityIsAlive(state.supervisor))) {
      return null;
    }
    await delay(100);
  }
  return null;
}

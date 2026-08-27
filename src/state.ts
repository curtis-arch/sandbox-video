import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  identityIsAlive,
  isIdentity,
  readLockOwner,
  sameIdentity,
  type OwnedProcessIdentity,
} from "./owned.js";
import { assertUploadsKey, assertUploadsWorkspace, type UploadsPublication } from "./uploads.js";
import {
  assertWithin,
  defined,
  hasCode,
  isPositiveInteger,
  isRecord,
  isStringArray,
  parseObject,
  positiveInteger,
  readBoundedText,
} from "./util.js";

export const SESSION_SCHEMA_VERSION = 1 as const;
export const STATE_NAME = "session.json";
export const CONFIG_NAME = "session-config.json";
export const SUPERVISOR_LOG_NAME = "supervisor.log";
export const RECOVERY_LOCK_NAME = "recovery.lock";
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_STOP_TIMEOUT_MS = 15_000;

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

export interface NormalizedSessionConfig {
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

export interface SessionPaths {
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
}

export function sessionPaths(runtimeDirectory: string): SessionPaths {
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

export async function ensureRuntimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readState(runtimeDirectory: string): Promise<RecordingSessionState | null> {
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

export async function writeState(state: RecordingSessionState): Promise<void> {
  const path = join(state.runtimeDirectory, STATE_NAME);
  const temporary = join(state.runtimeDirectory, `.${STATE_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function updateState(
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

/** Persist the terminal phase: "finished" when no failure, "failed" with its cause otherwise. */
export async function finishState(
  state: RecordingSessionState,
  failure: string | undefined,
  warnings: readonly string[],
): Promise<RecordingSessionState> {
  const now = new Date().toISOString();
  return updateState(state, {
    phase: failure === undefined ? "finished" : "failed",
    ...defined({ failure }),
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
    updatedAt: now,
    finishedAt: now,
  });
}

export async function readSessionConfig(
  runtimeDirectory: string,
): Promise<NormalizedSessionConfig> {
  const configPath = join(runtimeDirectory, CONFIG_NAME);
  return parseConfig(await readBoundedText(configPath), configPath);
}

const STATE_STRING_FIELDS = [
  "id",
  "display",
  "xauthorityPath",
  "displayLockPath",
  "playlistPath",
  "segmentPattern",
  "finalMp4Path",
  "supervisorLogPath",
  "agentBrowserSession",
  "agentBrowserNamespace",
  "startedAt",
  "updatedAt",
] as const;

const STATE_CONTAINED_PATH_FIELDS = [
  "xauthorityPath",
  "playlistPath",
  "segmentPattern",
  "finalMp4Path",
  "supervisorLogPath",
] as const;

const STATE_OPTIONAL_STRING_FIELDS = [
  "failure",
  "finishedAt",
  "browserClosedAt",
  "browserStartAttemptedAt",
] as const;

type RawSessionState = Record<string, unknown> &
  Record<(typeof STATE_STRING_FIELDS)[number], string> & {
    readonly phase: RecordingSessionPhase;
    readonly supervisor: OwnedProcessIdentity;
  };

function parseState(source: string, runtimeDirectory: string): RecordingSessionState {
  const parsed = parseObject(source, "recording state");
  if (!hasStateShape(parsed) || parsed.runtimeDirectory !== runtimeDirectory) {
    throw new Error("Invalid recording state");
  }
  assertStatePaths(parsed, runtimeDirectory);
  assertStateOptionals(parsed);
  return parsed as unknown as RecordingSessionState;
}

function hasStateShape(parsed: Record<string, unknown>): parsed is RawSessionState {
  return (
    parsed.schemaVersion === SESSION_SCHEMA_VERSION &&
    isPhase(parsed.phase) &&
    STATE_STRING_FIELDS.every((field) => typeof parsed[field] === "string") &&
    isPositiveInteger(parsed.width) &&
    isPositiveInteger(parsed.height) &&
    (parsed.fps === 30 || parsed.fps === 60) &&
    isPositiveInteger(parsed.segmentDurationSeconds) &&
    isIdentity(parsed.supervisor) &&
    isPhaseHistory(parsed.phaseHistory)
  );
}

function isPhaseHistory(
  value: unknown,
): value is readonly { readonly phase: RecordingSessionPhase; readonly at: string }[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && isPhase(entry.phase) && typeof entry.at === "string")
  );
}

function assertStatePaths(parsed: RawSessionState, runtimeDirectory: string): void {
  for (const field of STATE_CONTAINED_PATH_FIELDS) {
    assertWithin(runtimeDirectory, parsed[field]);
  }
  if (
    !/^:\d+$/u.test(parsed.display) ||
    !/^\/tmp\/sandbox-video-display-\d+\.lock$/u.test(parsed.displayLockPath)
  ) {
    throw new Error("Invalid recording display ownership state");
  }
}

function assertStateOptionals(parsed: RawSessionState): void {
  for (const owned of [parsed.xvfb, parsed.openbox, parsed.ffmpeg]) {
    if (owned !== undefined && !isIdentity(owned)) throw new Error("Invalid owned process state");
  }
  for (const field of STATE_OPTIONAL_STRING_FIELDS) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
      throw new Error(`Invalid recording state: ${field}`);
    }
  }
  if (parsed.warnings !== undefined && !isStringArray(parsed.warnings)) {
    throw new Error("Invalid recording warning state");
  }
  if (parsed.publication !== undefined && !isPublication(parsed.publication)) {
    throw new Error("Invalid recording publication state");
  }
}

interface RawSessionConfig {
  readonly id: string;
  readonly runtimeDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly fps: 30 | 60;
  readonly segmentDurationSeconds: number;
  readonly initialUrl: string;
  readonly displayNumber?: unknown;
  readonly upload?: unknown;
  readonly startupTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly executables: Required<RecordingExecutables>;
}

export function parseConfig(source: string, configPath: string): NormalizedSessionConfig {
  const parsed = parseObject(source, "recording config");
  if (!hasConfigShape(parsed)) throw new Error("Invalid recording config");
  const runtimeDirectory = validateRuntimeDirectory(parsed.runtimeDirectory);
  if (join(runtimeDirectory, CONFIG_NAME) !== configPath) {
    throw new Error("Recording config is outside its runtime directory");
  }
  const displayNumber = parseConfigDisplayNumber(parsed.displayNumber);
  if (parsed.upload !== undefined && !isUploadConfig(parsed.upload)) {
    throw new Error("Invalid recording upload config");
  }
  validateRecordingId(parsed.id);
  return {
    id: parsed.id,
    runtimeDirectory,
    width: parsed.width,
    height: parsed.height,
    fps: parsed.fps,
    segmentDurationSeconds: parsed.segmentDurationSeconds,
    initialUrl: validateInitialUrl(parsed.initialUrl),
    ...defined({ displayNumber }),
    startupTimeoutMs: parsed.startupTimeoutMs,
    stopTimeoutMs: parsed.stopTimeoutMs,
    executables: normalizeExecutables(parsed.executables),
    ...(parsed.upload === undefined ? {} : { upload: normalizeUpload(parsed.upload) }),
  };
}

function hasConfigShape(
  parsed: Record<string, unknown>,
): parsed is Record<string, unknown> & RawSessionConfig {
  return (
    typeof parsed.id === "string" &&
    typeof parsed.runtimeDirectory === "string" &&
    isPositiveInteger(parsed.width) &&
    isPositiveInteger(parsed.height) &&
    (parsed.fps === 30 || parsed.fps === 60) &&
    isPositiveInteger(parsed.segmentDurationSeconds) &&
    typeof parsed.initialUrl === "string" &&
    isPositiveInteger(parsed.startupTimeoutMs) &&
    isPositiveInteger(parsed.stopTimeoutMs) &&
    isExecutableRecord(parsed.executables)
  );
}

function parseConfigDisplayNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isPositiveInteger(value) || value > 65_535) {
    throw new Error("Invalid recording display number");
  }
  return value;
}

const EXECUTABLE_DEFAULTS: Required<RecordingExecutables> = {
  agentBrowser: "agent-browser",
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  mcookie: "mcookie",
  openbox: "openbox",
  xauth: "xauth",
  xdpyinfo: "xdpyinfo",
  xprop: "xprop",
  xvfb: "Xvfb",
};

const EXECUTABLE_NAMES = Object.keys(
  EXECUTABLE_DEFAULTS,
) as readonly (keyof Required<RecordingExecutables>)[];

function normalizeExecutables(overrides: RecordingExecutables): Required<RecordingExecutables> {
  const named = { ...EXECUTABLE_DEFAULTS };
  for (const name of EXECUTABLE_NAMES) {
    named[name] = executable(overrides[name] ?? EXECUTABLE_DEFAULTS[name]);
  }
  return named;
}

export function normalizeOptions(options: StartSessionOptions): NormalizedSessionConfig {
  const displayNumber = normalizeDisplayNumber(options.displayNumber);
  return {
    id: validateRecordingId(options.recordingId ?? randomUUID()),
    runtimeDirectory: validateRuntimeDirectory(options.runtimeDirectory),
    width: captureDimension(options.width, "width"),
    height: captureDimension(options.height, "height"),
    fps: validateFps(options.fps),
    segmentDurationSeconds: positiveInteger(
      options.segmentDurationSeconds ?? 10,
      "segmentDurationSeconds",
    ),
    initialUrl: validateInitialUrl(options.initialUrl ?? "about:blank"),
    ...defined({ displayNumber }),
    startupTimeoutMs: positiveInteger(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    ),
    stopTimeoutMs: positiveInteger(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "stopTimeoutMs",
    ),
    executables: normalizeExecutables(options.executables ?? {}),
    ...(options.upload === undefined ? {} : { upload: normalizeUpload(options.upload) }),
  };
}

function captureDimension(value: number, label: string): number {
  const dimension = positiveInteger(value, label);
  if (dimension > 16_384) throw new Error("Capture dimensions are too large");
  return dimension;
}

function validateFps(value: number): 30 | 60 {
  if (value !== 30 && value !== 60) throw new Error("fps must be 30 or 60");
  return value;
}

function normalizeDisplayNumber(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const displayNumber = positiveInteger(value, "displayNumber");
  if (displayNumber > 65_535) throw new Error("displayNumber must not exceed 65535");
  return displayNumber;
}

function validateRecordingId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error("recordingId must be a UUID");
  }
  return value;
}

export function assertCompatibleSession(
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
    ...defined({ workspace: options.workspace }),
    ...(options.executable === undefined ? {} : { executable: executable(options.executable) }),
  };
}

export function validateRuntimeDirectory(source: string): string {
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

const RECORDING_PHASES: ReadonlySet<string> = new Set([
  "starting",
  "recording",
  ...RECORDING_STOP_PHASES,
  "finished",
  "failed",
]);

function isPhase(value: unknown): value is RecordingSessionPhase {
  return typeof value === "string" && RECORDING_PHASES.has(value);
}

export function isActive(phase: RecordingSessionPhase): boolean {
  return phase !== "finished" && phase !== "failed";
}

function isPublication(value: unknown): value is UploadsPublication {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.url === "string" &&
    value.contentType === "video/mp4" &&
    isPositiveInteger(value.sizeBytes)
  );
}

function isExecutableRecord(value: unknown): value is Required<RecordingExecutables> {
  return (
    isRecord(value) &&
    EXECUTABLE_NAMES.every((name) => {
      const entry = value[name];
      return typeof entry === "string" && entry.length > 0;
    })
  );
}

function isUploadConfig(value: unknown): value is RecordingUploadOptions {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (value.workspace === undefined || typeof value.workspace === "string") &&
    (value.executable === undefined || typeof value.executable === "string")
  );
}

export function browserCleanupRequired(state: RecordingSessionState): boolean {
  return (
    state.browserStartAttemptedAt !== undefined ||
    state.phaseHistory.some((entry) => entry.phase === "recording")
  );
}

export function browserCleanupComplete(state: RecordingSessionState): boolean {
  return !browserCleanupRequired(state) || state.browserClosedAt !== undefined;
}

export function publicationComplete(
  state: RecordingSessionState,
  config: NormalizedSessionConfig,
): boolean {
  return config.upload === undefined || state.publication !== undefined;
}

export async function hasLiveOwnedProcess(state: RecordingSessionState): Promise<boolean> {
  for (const identity of [state.ffmpeg, state.openbox, state.xvfb]) {
    if (identity !== undefined && (await identityIsAlive(identity))) return true;
  }
  return false;
}

export async function hasOwnedDisplayLock(state: RecordingSessionState): Promise<boolean> {
  const owner = await readLockOwner(state.displayLockPath);
  return owner !== null && sameIdentity(owner, state.supervisor);
}

const PROGRESS_TAIL_BYTES = 16_384;

/**
 * Read the tail of FFmpeg's append-only progress log. The file grows without
 * bound during capture (~700 B/s), and the last complete block always carries
 * the current values, so the tail is sufficient and O(1) regardless of length.
 */
export async function readProgressTail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, PROGRESS_TAIL_BYTES);
    if (length === 0) return "";
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readCaptureProgress(progressPath: string): Promise<RecordingCaptureProgress> {
  let source: string;
  try {
    source = await readProgressTail(progressPath);
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

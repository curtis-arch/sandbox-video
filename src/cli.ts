#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  getSessionStatus,
  RECORDING_STOP_PHASES,
  startSession,
  stopSession,
  type RecordingSessionPhase,
  type RecordingSessionStatus,
} from "./session.js";
import { defined, delay } from "./util.js";

const CLI_VERSION = "0.2.0";
const SCHEMA_VERSION = 1 as const;
const RUNTIME_ROOT = "/tmp/sandbox-video";
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = "auto" as const;
const DEFAULT_STOP_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 250;
const EXIT_USAGE = 2;
const EXIT_FAILED = 4;
const EXIT_NOT_FOUND = 20;

const COMMANDS = [
  {
    name: "start",
    description: "Start one headed agent-browser recording in the current Sandbox.",
    effect: "mutating",
    parameters: [
      {
        name: "--fps",
        type: "string-or-integer",
        required: false,
        default: "auto",
        enum: ["auto", 30, 60],
        description:
          "Auto protects agent work and targets 60 FPS; 30 or 60 sets an explicit ceiling.",
      },
      {
        name: "--size",
        type: "string",
        required: false,
        default: "1920x1080",
        pattern: "WIDTHxHEIGHT",
      },
      {
        name: "--url",
        type: "string",
        required: false,
        default: "about:blank",
        description: "Open this page before display capture starts.",
      },
      {
        name: "--uploads-workspace",
        type: "string",
        required: false,
        sourceFallback: "UPLOADS_WORKSPACE",
      },
      {
        name: "--startup-timeout-ms",
        type: "integer",
        required: false,
        default: 30_000,
        description: "Fail start if the recording is not capturing within this window.",
      },
    ],
    agentInstructions: [
      "Retain data.recordingId and every token in data.agentBrowserCommand.",
      "Append each browser action to that exact agentBrowserCommand; do not create another session.",
      "Confirm frame growth with status, then call stop and wait for its URL before ending the Sandbox.",
      "Leave --fps at auto unless the user requests a fixed ceiling.",
    ],
    returns: ["recordingId", "agentBrowserCommand", "display", "fps", "capturePolicy", "size"],
    exitCodes: { "0": "recording started", "2": "invalid input", "4": "startup failed" },
  },
  {
    name: "status",
    description: "Read recorder phase and live frame progress without changing it.",
    effect: "read-only",
    parameters: [{ name: "--recording-id", type: "uuid", required: true }],
    agentInstructions: [
      "This command does not change the recording.",
      "During validation, confirm data.capture.frame increases between status calls; under full CPU load, wait and retry one stalled sample.",
    ],
    returns: [
      "status",
      "recordingId",
      "supervisorAlive",
      "capture",
      "url",
      "key",
      "contentType",
      "sizeBytes",
      "measuredFps",
      "frames",
      "durationSeconds",
      "capturePolicy",
    ],
    exitCodes: {
      "0": "status read",
      "2": "invalid input",
      "4": "recording failed",
      "20": "recording not found",
    },
  },
  {
    name: "stop",
    description: "Close the browser, finalize and verify one MP4, upload it, and clean up.",
    effect: "mutating-idempotent",
    parameters: [
      { name: "--recording-id", type: "uuid", required: true },
      { name: "--timeout-ms", type: "integer", required: false, default: DEFAULT_STOP_TIMEOUT_MS },
    ],
    agentInstructions: [
      "Call stop once; concurrent or repeated calls for the same recording are idempotent.",
      "Continue reading NDJSON progress events from stderr until the command exits.",
      "Do not end the Sandbox unless exit is 0 and the stdout envelope contains data.url.",
      "Treat data.measuredFps as telemetry, not a pass or fail threshold.",
    ],
    returns: [
      "status",
      "recordingId",
      "url",
      "key",
      "contentType",
      "sizeBytes",
      "measuredFps",
      "frames",
      "durationSeconds",
      "capturePolicy",
    ],
    exitCodes: {
      "0": "proof uploaded",
      "2": "invalid input",
      "4": "finalization failed",
      "20": "recording not found",
    },
  },
] as const;

const INFO_COMMANDS = new Map<string, { readonly label: string; readonly payload: () => object }>([
  ["--help", { label: "help", payload: helpPayload }],
  ["help", { label: "help", payload: helpPayload }],
  ["manifest", { label: "help", payload: helpPayload }],
  ["--brief", { label: "brief", payload: () => ({ brief: brief() }) }],
  ["--version", { label: "version", payload: () => ({ version: CLI_VERSION }) }],
]);

const SUBCOMMANDS = new Map<string, (argv: readonly string[]) => Promise<number>>([
  ["start", startCommand],
  ["status", statusCommand],
  ["stop", stopCommand],
]);

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    writeSuccess(helpPayload(), "help", "none");
    return 0;
  }
  try {
    const info = INFO_COMMANDS.get(command);
    if (info !== undefined) {
      if (argv.length !== 1) throw new UsageError(`${command} does not accept arguments`);
      writeSuccess(info.payload(), info.label, "none");
      return 0;
    }
    const run = SUBCOMMANDS.get(command);
    if (run === undefined) {
      throw new UsageError(
        `Unknown command: ${command}`,
        "Run 'sandbox-video --help' and select a command from data.commands.",
      );
    }
    if (argv[1] === "--help") {
      if (argv.length !== 2) throw new UsageError("--help does not accept other arguments");
      writeSuccess({ command: commandDefinition(command) }, `${command} --help`, "none");
      return 0;
    }
    return await run(argv.slice(1));
  } catch (error) {
    return fail(error, command);
  }
}

async function startCommand(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(
    argv,
    new Set(["fps", "size", "url", "uploads-workspace", "startup-timeout-ms"]),
  );
  const recordingId = randomUUID();
  const fpsFlag = flags.get("fps") ?? DEFAULT_FPS;
  if (fpsFlag !== "auto" && fpsFlag !== "30" && fpsFlag !== "60") {
    throw new UsageError("--fps must be auto, 30, or 60");
  }
  const fpsValue = fpsFlag === "30" ? 30 : fpsFlag === "60" ? 60 : "auto";
  const { width, height } = parseSize(flags.get("size") ?? `${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}`);
  const workspace = flags.get("uploads-workspace") ?? process.env.UPLOADS_WORKSPACE;
  const initialUrl = flags.get("url");
  const startupTimeout = flags.get("startup-timeout-ms");
  const startupTimeoutMs =
    startupTimeout === undefined ? undefined : integer(startupTimeout, "--startup-timeout-ms");
  const state = await startSession({
    recordingId,
    runtimeDirectory: runtimeDirectoryFor(recordingId),
    width,
    height,
    fps: fpsValue,
    ...defined({ initialUrl, startupTimeoutMs }),
    upload: {
      key: `screenshots/sandbox-video/${recordingId}/proof.mp4`,
      ...defined({ workspace }),
    },
  }).catch((error: unknown) => {
    throw new CommandError(
      `Recording ${recordingId} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      `Inspect /tmp/sandbox-video/${recordingId} for retained state and logs; run sandbox-video stop --recording-id ${recordingId} if a partial recording remains.`,
    );
  });
  if (state.phase !== "recording")
    throw new Error(state.failure ?? `Recording startup ended in phase ${state.phase}`);
  writeSuccess(
    {
      status: "recording",
      recordingId: state.id,
      display: state.display,
      fps: state.fps,
      ...defined({ capturePolicy: state.capturePolicy }),
      size: `${state.width}x${state.height}`,
      agentBrowserCommand: [
        "agent-browser",
        "--namespace",
        state.agentBrowserNamespace,
        "--session",
        state.agentBrowserSession,
      ],
      next: [
        "Append an agent-browser action to data.agentBrowserCommand for every browser interaction.",
        `Run sandbox-video status --recording-id ${state.id} to verify capture progress.`,
        `Run sandbox-video stop --recording-id ${state.id} and wait for data.url before ending the Sandbox.`,
      ],
    },
    "start",
    "recording-started",
  );
  return 0;
}

async function statusCommand(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["recording-id"]));
  const recordingId = requiredFlag(flags, "recording-id");
  const status = await getSessionStatus(runtimeDirectoryFor(recordingId));
  if (!status.exists) throw new NotFoundError(recordingId);
  if (status.state.phase === "failed") {
    throw new CommandError(
      status.state.failure ?? "Recording failed",
      `Inspect /tmp/sandbox-video/${recordingId} for retained state and logs; do not reuse this recording ID.`,
    );
  }
  writeSuccess(statusPayload(status), "status", "none");
  return 0;
}

async function stopCommand(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["recording-id", "timeout-ms"]));
  const recordingId = requiredFlag(flags, "recording-id");
  const timeoutMs = integer(
    flags.get("timeout-ms") ?? String(DEFAULT_STOP_TIMEOUT_MS),
    "--timeout-ms",
  );
  const runtimeDirectory = runtimeDirectoryFor(recordingId);
  const initial = await getSessionStatus(runtimeDirectory);
  if (!initial.exists) throw new NotFoundError(recordingId);
  const stop = stopSession({ runtimeDirectory, timeoutMs });
  let stopSettled = false;
  const settle = () => {
    stopSettled = true;
  };
  void stop.then(settle, settle);
  const seen = new Set<RecordingSessionPhase>();
  emitStopPhases(
    initial.state.phaseHistory.map((entry) => entry.phase),
    seen,
    recordingId,
  );
  await pollStopProgress(
    runtimeDirectory,
    recordingId,
    seen,
    Date.now() + timeoutMs,
    () => stopSettled,
  );
  const result = await stop;
  if (!result.exists) throw new NotFoundError(recordingId);
  emitStopPhases(
    result.state.phaseHistory.map((entry) => entry.phase),
    seen,
    recordingId,
  );
  if (result.state.phase !== "finished" || result.state.publication === undefined) {
    throw new CommandError(
      result.state.failure ??
        (result.state.phase === "finished"
          ? "Recording finished without an uploaded MP4"
          : `Recording finalization ended in phase ${result.state.phase}`),
      `Run sandbox-video status --recording-id ${recordingId} to inspect retained state before deciding whether to retry.`,
    );
  }
  writeSuccess(statusPayload(result), "stop", "proof-uploaded");
  return 0;
}

async function pollStopProgress(
  runtimeDirectory: string,
  recordingId: string,
  seen: Set<RecordingSessionPhase>,
  deadline: number,
  stopSettled: () => boolean,
): Promise<void> {
  while (!stopSettled() && Date.now() < deadline) {
    const current = await getSessionStatus(runtimeDirectory);
    if (!current.exists) return;
    emitStopPhases(
      current.state.phaseHistory.map((entry) => entry.phase),
      seen,
      recordingId,
    );
    if (current.state.phase === "finished" || current.state.phase === "failed") return;
    await delay(POLL_INTERVAL_MS);
  }
}

function statusPayload(status: Extract<RecordingSessionStatus, { readonly exists: true }>): object {
  const { state } = status;
  return {
    status: state.phase,
    recordingId: state.id,
    supervisorAlive: status.supervisorAlive,
    capture: status.capture,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    ...defined({ finishedAt: state.finishedAt }),
    ...defined({ capturePolicy: state.capturePolicy }),
    ...(state.media === undefined ? {} : state.media),
    ...(state.publication === undefined ? {} : state.publication),
    ...defined({ error: state.failure }),
    ...defined({ warnings: state.warnings }),
  };
}

function emitStopPhases(
  phases: readonly RecordingSessionPhase[],
  seen: Set<RecordingSessionPhase>,
  recordingId: string,
): void {
  for (const phase of RECORDING_STOP_PHASES) {
    if (!phases.includes(phase) || seen.has(phase)) continue;
    seen.add(phase);
    process.stderr.write(
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, type: "progress", command: "stop", recordingId, step: RECORDING_STOP_PHASES.indexOf(phase) + 1, totalSteps: RECORDING_STOP_PHASES.length, phase })}\n`,
    );
  }
}

function helpPayload(): object {
  return {
    help: brief(),
    commands: COMMANDS,
    agentWorkflow: [
      "Call start and retain data.recordingId plus every token in data.agentBrowserCommand.",
      "Use that exact command prefix for all agent-browser open, snapshot, click, and inspection calls.",
      "Call status and confirm data.capture.frame increases before final validation.",
      "Call stop once, continue reading JSON progress from stderr, and wait for data.url on stdout.",
      "Do not terminate the Sandbox until stop exits 0 and returns the hosted MP4 URL.",
    ],
    prerequisites: [
      "Node.js >=24",
      "FFmpeg and ffprobe",
      "nice from GNU coreutils",
      "Xvfb and openbox",
      "agent-browser with Chromium",
      "authenticated uploads.sh CLI",
    ],
    outputContract: {
      stdout: "On success, exactly one JSON response envelope; otherwise empty.",
      stderr:
        "On failure, one JSON error envelope. During stop, newline-delimited JSON progress events precede any failure envelope.",
      envelope: {
        schemaVersion: 1,
        ok: "boolean",
        data: "object on success",
        error: "object on failure",
        meta: "object",
      },
      failureEffects: {
        none: "No command side effect occurred; correct the input before retrying.",
        "recording-start-uncertain":
          "Startup began but failed; inspect the error and runtime state before retrying.",
        "finalization-partial":
          "Stop began but failed; query status before deciding whether to repeat stop.",
      },
    },
    update: {
      automatic: false,
      reason: "Automatic updates can change schemas during an agent session.",
      command: `npm install --global sandbox-video@${CLI_VERSION}`,
      rule: "Pin one exact version for start, status, and stop within a Sandbox.",
    },
  };
}

function commandDefinition(name: string): (typeof COMMANDS)[number] {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) throw new UsageError(`Unknown command: ${name}`);
  return command;
}

function brief(): string {
  return "sandbox-video automatically targets the highest practical frame rate while protecting agent work inside an existing Vercel Sandbox, verifies one browser-compatible MP4, reports its measured frame rate, uploads it through uploads.sh, and returns the proof URL.";
}

function runtimeDirectoryFor(recordingId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(recordingId)
  ) {
    throw new UsageError("--recording-id must be a UUID");
  }
  return join(RUNTIME_ROOT, recordingId);
}

function parseSize(value: string): { readonly width: number; readonly height: number } {
  const match = /^(\d+)x(\d+)$/u.exec(value);
  if (match === null) throw new UsageError("--size must be WIDTHxHEIGHT");
  const width = integer(match[1]!, "--size width");
  const height = integer(match[2]!, "--size height");
  if (width > 7680 || height > 4320) throw new UsageError("--size cannot exceed 7680x4320");
  return { width, height };
}

function integer(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new UsageError(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new UsageError(`${label} must be a positive integer`);
  return parsed;
}

function parseFlags(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const raw = argv[index];
    const value = argv[index + 1];
    if (
      raw === undefined ||
      !raw.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new UsageError(`Expected --flag value, received: ${raw ?? "<end>"}`);
    }
    const name = raw.slice(2);
    if (!allowed.has(name)) throw new UsageError(`Unknown flag: ${raw}`);
    if (values.has(name)) throw new UsageError(`Duplicate flag: ${raw}`);
    values.set(name, value);
  }
  return values;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined)
    throw new UsageError(`--${name} is required`, `Retry with --${name} followed by its value.`);
  return value;
}

function fail(error: unknown, command: string): number {
  writeError(error, command);
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof NotFoundError) return EXIT_NOT_FOUND;
  return EXIT_FAILED;
}

function writeSuccess(data: unknown, command: string, effect: string): void {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, data, meta: { cliVersion: CLI_VERSION, command, effect } })}\n`,
  );
}

function writeError(error: unknown, command: string): void {
  const usage = error instanceof UsageError;
  const notFound = error instanceof NotFoundError;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: {
      code: usage ? "INVALID_ARGUMENT" : notFound ? "RECORDING_NOT_FOUND" : "COMMAND_FAILED",
      message: safeMessage(error),
      suggestion:
        error instanceof CliError
          ? error.suggestion
          : "Inspect the message, verify prerequisites with sandbox-video --help, then retry only if the failed command is safe to repeat.",
      retryable: false,
    },
    meta: { cliVersion: CLI_VERSION, command, effect: failureEffect(error, command) },
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function failureEffect(error: unknown, command: string): string {
  if (error instanceof UsageError || error instanceof NotFoundError) return "none";
  if (command === "start") return "recording-start-uncertain";
  if (command === "stop") return "finalization-partial";
  return "none";
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|AUTH)/iu.test(name) && value !== undefined && value.length > 0,
    )
    .map(([, value]) => value!);
  return secrets
    .reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), message)
    .slice(0, 2_000);
}

class CliError extends Error {
  constructor(
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
  }
}

class UsageError extends CliError {
  constructor(
    message: string,
    suggestion = "Run 'sandbox-video --help', then retry with only the documented flags and values.",
  ) {
    super(message, suggestion);
  }
}

class CommandError extends CliError {}

class NotFoundError extends CliError {
  constructor(recordingId: string) {
    super(
      `Recording not found: ${recordingId}`,
      "Use the recordingId returned by start in the same Sandbox filesystem.",
    );
  }
}

void main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    writeError(error, "unknown");
    process.exitCode = EXIT_FAILED;
  },
);

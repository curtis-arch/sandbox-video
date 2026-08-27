import { spawn } from "node:child_process";

import { settleWithin } from "./util.js";

const STREAM_CLOSE_GRACE_MS = 1_000;

export interface ExactCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExactCommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly signal?: AbortSignal;
}

function assertRunOptions(options: ExactCommandOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Command timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.outputLimitBytes) || options.outputLimitBytes <= 0) {
    throw new Error("Command output limit must be a positive safe integer");
  }
}

/** Run one argv-safe subprocess and return once it exits and its output settles. */
export async function runExact(
  argv: readonly [string, ...string[]],
  options: ExactCommandOptions,
): Promise<ExactCommandResult> {
  assertRunOptions(options);
  options.signal?.throwIfAborted();
  const child = spawn(argv[0], argv.slice(1), {
    env: options.environment ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let exceededLimit = false;
  const append = (current: string, chunk: string): string => {
    if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > options.outputLimitBytes) {
      exceededLimit = true;
      child.kill("SIGKILL");
      return current;
    }
    return current + chunk;
  };
  child.stdout.on("data", (chunk: string) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = append(stderr, chunk);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    const result = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly error?: string;
    }>((resolve) => {
      child.once("error", (error) => {
        resolve({ exitCode: null, signal: null, error: error.message });
      });
      child.once("exit", (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    });
    // Wait briefly for the output streams to drain, but do not require it: a
    // grandchild that daemonized while inheriting the pipes would otherwise
    // hold "close" open until the command timeout despite a clean exit. A
    // spawn failure emits no "close", so skip the grace wait entirely. When
    // the grace expires, destroy the pipes so a holdout grandchild cannot
    // keep this process alive or keep feeding the buffers.
    if (
      result.error === undefined &&
      (await settleWithin(closed, STREAM_CLOSE_GRACE_MS)) === null
    ) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (exceededLimit) throw new Error(`${argv[0]} output exceeded the safety limit`);
    if (timedOut) throw new Error(`${argv[0]} timed out`);
    options.signal?.throwIfAborted();
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

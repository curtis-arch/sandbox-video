import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink, writeFile } from "node:fs/promises";

import {
  delay,
  hasCode,
  isPositiveInteger,
  isRecord,
  parseObject,
  readBoundedText,
  settleWithin,
} from "./util.js";

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly executable: string;
}

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly identity: OwnedProcessIdentity;
  readonly exit: Promise<ProcessExit>;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export function isIdentity(value: unknown): value is OwnedProcessIdentity {
  return (
    isRecord(value) &&
    isPositiveInteger(value.pid) &&
    typeof value.startTimeTicks === "string" &&
    /^\d+$/u.test(value.startTimeTicks) &&
    typeof value.executable === "string" &&
    value.executable.length > 0 &&
    !value.executable.includes("\0")
  );
}

export async function processIdentity(
  pid: number,
  executableName: string,
): Promise<OwnedProcessIdentity> {
  const startTimeTicks = await readProcessStartTime(pid);
  return { pid, startTimeTicks, executable: executableName };
}

export async function currentIdentity(): Promise<OwnedProcessIdentity> {
  return processIdentity(process.pid, process.execPath);
}

export async function identityIsAlive(identity: OwnedProcessIdentity): Promise<boolean> {
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

export function sameIdentity(left: OwnedProcessIdentity, right: OwnedProcessIdentity): boolean {
  return left.pid === right.pid && left.startTimeTicks === right.startTimeTicks;
}

export async function signalOwned(
  identity: OwnedProcessIdentity,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!(await identityIsAlive(identity))) return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}

export async function waitForIdentityExit(
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

export async function stopOwned(
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

export async function tryCreateOwnedLock(
  path: string,
  owner: OwnedProcessIdentity,
): Promise<boolean> {
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

export async function readLockOwner(path: string): Promise<OwnedProcessIdentity | null> {
  try {
    const parsed = parseObject(await readBoundedText(path), "lock");
    return isIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove a lock believed stale without racing a contender that already
 * replaced it: claim the file atomically via rename, verify what was caught,
 * and restore it when it turned out to be a live owner's fresh lock.
 */
export async function removeStaleLock(
  path: string,
  stale: OwnedProcessIdentity | null,
): Promise<boolean> {
  const graveyard = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, graveyard);
  } catch {
    return false;
  }
  const caught = await readLockOwner(graveyard);
  const caughtFreshLock =
    caught !== null &&
    (stale === null || !sameIdentity(caught, stale)) &&
    (await identityIsAlive(caught));
  if (caughtFreshLock) await link(graveyard, path).catch(() => undefined);
  await unlink(graveyard).catch(() => undefined);
  return !caughtFreshLock;
}

export async function releaseOwnedLock(path: string, owner: OwnedProcessIdentity): Promise<void> {
  const current = await readLockOwner(path);
  if (current !== null && sameIdentity(current, owner)) await unlink(path).catch(() => undefined);
}

export async function acquireRecoveryLock(
  path: string,
  owner: OwnedProcessIdentity,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await tryCreateOwnedLock(path, owner)) return true;
    const current = await readLockOwner(path);
    if (current !== null && (await identityIsAlive(current))) return false;
    await removeStaleLock(path, current);
  }
  return false;
}

export async function spawnManaged(
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

export async function unexpectedExit(
  label: string,
  process: ManagedProcess,
): Promise<{ readonly type: "exit"; readonly message: string }> {
  const result = await process.exit;
  return {
    type: "exit",
    message: `${label} exited unexpectedly (${formatExit(result)})`,
  };
}

export async function stopManaged(
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

export async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

export function formatExit(result: ProcessExit): string {
  if (result.error !== undefined) return result.error;
  if (result.exitCode !== null) return `exit ${result.exitCode}`;
  return result.signal ?? "unknown termination";
}

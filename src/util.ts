import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function remainingTimeout(deadline: number, maximum: number, label: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded the stop timeout`);
  return Math.max(1, Math.min(maximum, remaining));
}

export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
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

export async function fileIsNonempty(path: string): Promise<boolean> {
  try {
    const value = await stat(path);
    return value.isFile() && value.size > 0;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function readBoundedText(path: string): Promise<string> {
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source) > 1_000_000) throw new Error(`File is too large: ${path}`);
  return source;
}

export function parseObject(source: string, label: string): Record<string, unknown> {
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

export function assertWithin(directory: string, path: string): void {
  const normalized = resolve(path);
  if (normalized !== directory && !normalized.startsWith(`${directory}${sep}`)) {
    throw new Error("Recording state path escapes its runtime directory");
  }
}

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/** Drop undefined-valued entries so optional properties stay absent under exactOptionalPropertyTypes. */
export function defined<T extends Record<string, unknown>>(source: T): Partial<Defined<T>> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<Defined<T>>;
}

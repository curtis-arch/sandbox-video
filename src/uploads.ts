import { stat } from "node:fs/promises";

import { runExact, type ExactCommandResult } from "./process.js";
import { defined, delay, isRecord } from "./util.js";

const OUTPUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const SAFE_KEY = /^(?:f|gh|screenshots)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SAFE_WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface UploadFinalMp4Options {
  readonly filePath: string;
  readonly key: string;
  readonly workspace?: string;
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface UploadsPublication {
  readonly key: string;
  readonly url: string;
  readonly contentType: "video/mp4";
  readonly sizeBytes: number;
}

/** Publish one finalized MP4 through the authenticated uploads.sh CLI. */
export async function uploadFinalMp4(options: UploadFinalMp4Options): Promise<UploadsPublication> {
  assertUploadsKey(options.key);
  if (options.workspace !== undefined) assertUploadsWorkspace(options.workspace);
  const sizeBytes = await sourceFileSize(options.filePath);
  const environment = uploadsEnvironment(options.environment ?? process.env, options.workspace);
  const workspaceArgs = options.workspace === undefined ? [] : ["--workspace", options.workspace];
  const result = await runExact(
    [
      options.executable ?? "uploads",
      "put",
      options.filePath,
      "--key",
      options.key,
      ...workspaceArgs,
      "--content-type",
      "video/mp4",
      "--no-optimize",
      "--no-git",
      "--no-auto",
      "--no-pr",
      "--format",
      "json",
      "--replace",
    ],
    {
      environment,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      ...defined({ signal: options.signal }),
    },
  );
  if (result.exitCode !== 0) throw uploadFailure(result, environment);
  const publication = parseUploadsPublication(result.stdout, options.key, sizeBytes);
  await verifyHostedPublication(
    publication,
    Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
  );
  return publication;
}

/** Parse the CLI's single JSON response and bind it to the requested upload. */
export function parseUploadsPublication(
  source: string,
  expectedKey: string,
  expectedSizeBytes: number,
): UploadsPublication {
  assertUploadsKey(expectedKey);
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes <= 0) {
    throw new Error("Expected upload size must be a positive safe integer");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("uploads put did not return valid JSON");
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error("uploads put returned a non-object JSON payload");
  }
  if (parsed.key !== expectedKey) {
    throw new Error("uploads put returned a different storage key");
  }
  if (typeof parsed.url !== "string") {
    throw new Error("uploads put response is missing its URL");
  }
  const url = parsePublicUrl(parsed.url);
  assertReportedSize(parsed.size, expectedSizeBytes);
  assertReportedSize(parsed.sizeBytes, expectedSizeBytes);
  return {
    key: expectedKey,
    url,
    contentType: "video/mp4",
    sizeBytes: expectedSizeBytes,
  };
}

export function assertUploadsKey(key: string): void {
  if (
    !SAFE_KEY.test(key) ||
    key.endsWith("/") ||
    key.includes("//") ||
    key.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid uploads.sh key: ${JSON.stringify(key)}`);
  }
}

export function assertUploadsWorkspace(workspace: string): void {
  if (!SAFE_WORKSPACE.test(workspace)) {
    throw new Error(`Invalid uploads.sh workspace: ${JSON.stringify(workspace)}`);
  }
}

async function sourceFileSize(filePath: string): Promise<number> {
  const source = await stat(filePath);
  if (!source.isFile() || !Number.isSafeInteger(source.size) || source.size <= 0) {
    throw new Error("Final MP4 must be a non-empty regular file");
  }
  return source.size;
}

function uploadFailure(result: ExactCommandResult, environment: NodeJS.ProcessEnv): Error {
  const termination =
    result.error ??
    (result.exitCode === null
      ? `terminated by ${result.signal ?? "an unknown signal"}`
      : `exited ${result.exitCode}`);
  return new Error(
    `uploads put ${termination}: ${safeDetail(result.stderr || result.stdout, environment)}`,
  );
}

function assertReportedSize(value: unknown, expectedSizeBytes: number): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || value !== expectedSizeBytes) {
    throw new Error("uploads put returned an unexpected file size");
  }
}

function uploadsEnvironment(source: NodeJS.ProcessEnv, workspace?: string): NodeJS.ProcessEnv {
  const token = source.UPLOADS_TOKEN;
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...defined({ HOME: source.HOME }),
    ...defined({ XDG_CONFIG_HOME: source.XDG_CONFIG_HOME }),
    ...defined({ BUILDINTERNET_CONFIG: source.BUILDINTERNET_CONFIG }),
    ...(token === undefined || token.length === 0 ? {} : { UPLOADS_TOKEN: token }),
    ...defined({ UPLOADS_WORKSPACE: workspace }),
    ...defined({ UPLOADS_API_URL: source.UPLOADS_API_URL }),
    ...defined({ UPLOADS_SESSION_TOKEN: source.UPLOADS_SESSION_TOKEN }),
  };
}

function parsePublicUrl(source: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("uploads put returned an invalid URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("uploads put returned a non-public URL");
  }
  return url.toString();
}

async function verifyHostedPublication(
  publication: UploadsPublication,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let detail = "hosted object did not become available";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(publication.url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, deadline - Date.now()))),
      });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const contentLength = Number(response.headers.get("content-length"));
      if (
        response.ok &&
        contentType === publication.contentType &&
        Number.isSafeInteger(contentLength) &&
        contentLength === publication.sizeBytes
      ) {
        return;
      }
      detail = `HTTP ${response.status}, content-type ${contentType ?? "missing"}, content-length ${String(contentLength)}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Uploaded MP4 verification failed: ${detail}`);
}

function safeDetail(source: string, environment: NodeJS.ProcessEnv): string {
  let detail = source.trim() || "no error output";
  for (const [name, value] of Object.entries(environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|AUTH)/iu.test(name) && value !== undefined && value.length > 0) {
      detail = detail.replaceAll(value, "[REDACTED]");
    }
  }
  return detail.slice(0, 1_000);
}

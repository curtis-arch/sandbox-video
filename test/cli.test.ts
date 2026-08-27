import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../src/cli.js", import.meta.url);

test("--help describes the complete command contract as JSON", () => {
  const result = runCli("--help");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");

  const response = object(parseJson(result.stdout));
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.ok, true);
  const data = object(response.data);
  const commands = array(data.commands).map(object);
  assert.deepEqual(
    commands.map((command) => command.name),
    ["start", "status", "stop"],
  );
  for (const command of commands) {
    assert.equal(typeof command.description, "string");
    assert.equal(typeof command.effect, "string");
    assert.ok(array(command.agentInstructions).length > 0);
    for (const parameter of array(command.parameters).map(object)) {
      assert.equal(typeof parameter.type, "string");
      assert.equal(typeof parameter.required, "boolean");
    }
  }
  const status = commands.find((command) => command.name === "status");
  assert.ok(status !== undefined);
  assert.deepEqual(array(status.returns), [
    "status",
    "recordingId",
    "supervisorAlive",
    "capture",
    "url",
    "key",
    "contentType",
    "sizeBytes",
  ]);
  const start = commands.find((command) => command.name === "start");
  assert.ok(start !== undefined);
  const startParameters = array(start.parameters).map(object);
  assert.equal(
    startParameters.find((parameter) => parameter.name === "--url")?.default,
    "about:blank",
  );
});

test("--version matches the npm package version", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const result = runCli("--version");
  assert.equal(result.status, 0);
  const response = object(parseJson(result.stdout));
  assert.equal(object(response.data).version, packageJson.version);
});

test("invalid input fails without stdout and explains recovery as JSON", () => {
  const result = runCli("unknown-command");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");

  const response = object(parseJson(result.stderr));
  const error = object(response.error);
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.ok, false);
  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.match(string(error.suggestion), /--help/u);

  const trailing = runCli("--version", "unexpected");
  assert.equal(trailing.status, 2);
  assert.equal(trailing.stdout, "");
  assert.equal(object(parseJson(trailing.stderr)).ok, false);
});

test("recording IDs remain case-insensitive", () => {
  const result = runCli("status", "--recording-id", "00000000-0000-4000-8000-00000000000A");
  assert.equal(result.status, 20);
  assert.equal(result.stdout, "");
  assert.equal(object(object(parseJson(result.stderr)).error).code, "RECORDING_NOT_FOUND");
});

function runCli(...arguments_: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cli.pathname, ...arguments_], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string");
  return value;
}

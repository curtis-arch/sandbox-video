import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getSessionStatus,
  startSession,
  stopSession,
  type OwnedProcessIdentity,
  type RecordingExecutables,
  type RecordingSessionPhase,
  type RecordingSessionState,
} from "../src/session.js";
import { identityIsAlive } from "../src/owned.js";
import { assertCompatibleSession, normalizeOptions, parseConfig, readState } from "../src/state.js";
import type { UploadsPublication } from "../src/uploads.js";
import { parseObject } from "../src/util.js";

const linuxOnly = { skip: process.platform !== "linux" } as const;

test("browser opens the configured URL before FFmpeg capture starts", linuxOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-video-start-order-"));
  const executableDirectory = join(root, "bin");
  const runtimeDirectory = join(root, "runtime");
  const eventLog = join(root, "events.log");
  await mkdir(executableDirectory, { recursive: true });

  const paths = {
    agentBrowser: join(executableDirectory, "agent-browser"),
    ffmpeg: join(executableDirectory, "ffmpeg"),
    ffprobe: join(executableDirectory, "ffprobe"),
    mcookie: join(executableDirectory, "mcookie"),
    openbox: join(executableDirectory, "openbox"),
    xauth: join(executableDirectory, "xauth"),
    xdpyinfo: join(executableDirectory, "xdpyinfo"),
    xprop: join(executableDirectory, "xprop"),
    xvfb: join(executableDirectory, "Xvfb"),
  } satisfies Required<RecordingExecutables>;
  const persistentProcess =
    '#!/usr/bin/env node\nprocess.on("SIGINT",()=>process.exit(0));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);\n';
  const expectedPreset = availableParallelism() <= 1 ? "ultrafast" : "veryfast";

  await Promise.all([
    writeExecutable(
      paths.agentBrowser,
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(eventLog)}, "browser:" + process.argv.at(-1) + "\\n");\n`,
    ),
    writeExecutable(
      paths.ffmpeg,
      `#!/usr/bin/env node\nconst fs=require("node:fs");const os=require("node:os");const args=process.argv.slice(2);const progress=args.indexOf("-progress");if(progress>=0){const preset=args[args.indexOf("-preset")+1];fs.appendFileSync(${JSON.stringify(eventLog)},"ffmpeg:"+os.getPriority(0)+":"+preset+"\\n");fs.writeFileSync(args[progress+1],"frame=1\\nout_time_ms=16667\\nprogress=continue\\n");fs.writeFileSync(args.at(-1),"playlist\\n");process.on("SIGINT",()=>process.exit(0));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)}else{if(args.at(-1)!=="-")fs.writeFileSync(args.at(-1),"video")}\n`,
    ),
    writeExecutable(
      paths.ffprobe,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"avg_frame_rate":"30/1","nb_frames":"30"}],"format":{"duration":"1"}}\'\n',
    ),
    writeExecutable(paths.mcookie, "#!/bin/sh\nprintf 'abc123\\n'\n"),
    writeExecutable(paths.openbox, persistentProcess),
    writeExecutable(
      paths.xauth,
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv[3],"");\n',
    ),
    writeExecutable(paths.xdpyinfo, "#!/bin/sh\nexit 0\n"),
    writeExecutable(
      paths.xprop,
      "#!/bin/sh\nprintf '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1\\n'\n",
    ),
    writeExecutable(paths.xvfb, persistentProcess),
  ]);

  try {
    const initialUrl = "http://127.0.0.1:4173/proof";
    const state = await startSession({
      recordingId: "00000000-0000-4000-8000-000000000007",
      runtimeDirectory,
      width: 1280,
      height: 720,
      initialUrl,
      displayNumber: 65_007,
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      executables: paths,
    });

    assert.equal(state.phase, "recording");
    assert.deepEqual(state.capturePolicy, {
      mode: "auto",
      targetFps: 60,
      encoderPreset: expectedPreset,
      processPriority: 10,
      availableVcpus: availableParallelism(),
    });
    assert.ok(state.ffmpeg !== undefined);
    const ffmpegIdentity = state.ffmpeg;
    assert.deepEqual((await readFile(eventLog, "utf8")).trim().split("\n").slice(0, 2), [
      `browser:${initialUrl}`,
      `ffmpeg:10:${expectedPreset}`,
    ]);
    const stopped = await stopSession({ runtimeDirectory, timeoutMs: 5_000 });
    assert.equal(stopped.exists && stopped.state.phase, "finished");
    assert.equal(await identityIsAlive(ffmpegIdentity), false);
  } finally {
    await stopSession({ runtimeDirectory, timeoutMs: 5_000 }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("startup timeout returns only after detached processes are reaped", linuxOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-video-start-timeout-"));
  const executableDirectory = join(root, "bin");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(executableDirectory, { recursive: true });

  const xvfb = join(executableDirectory, "Xvfb");
  const xauth = join(executableDirectory, "xauth");
  const mcookie = join(executableDirectory, "mcookie");
  const xdpyinfo = join(executableDirectory, "xdpyinfo");
  await Promise.all([
    writeExecutable(
      xvfb,
      '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>setTimeout(()=>process.exit(0),400));setInterval(()=>{},1000);\n',
    ),
    writeExecutable(
      xauth,
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv[3],"");\n',
    ),
    writeExecutable(mcookie, "#!/bin/sh\nprintf 'abc123\\n'\n"),
    writeExecutable(xdpyinfo, "#!/bin/sh\nexit 1\n"),
  ]);

  try {
    await assert.rejects(
      startSession({
        recordingId: "00000000-0000-4000-8000-000000000008",
        runtimeDirectory,
        width: 1280,
        height: 720,
        fps: 30,
        displayNumber: 65_008,
        startupTimeoutMs: 200,
        stopTimeoutMs: 2_000,
        executables: {
          agentBrowser: "/usr/bin/true",
          ffmpeg: "/usr/bin/true",
          ffprobe: "/usr/bin/true",
          mcookie,
          openbox: "/usr/bin/true",
          xauth,
          xdpyinfo,
          xprop: "/usr/bin/true",
          xvfb,
        },
      }),
      /Recording startup did not finish/u,
    );

    const status = await getSessionStatus(runtimeDirectory);
    assert.equal(status.exists, true);
    if (!status.exists) return;
    assert.equal(status.supervisorAlive, false);
    assert.equal(
      status.state.xvfb === undefined || !(await identityIsAlive(status.state.xvfb)),
      true,
    );
  } finally {
    await stopSession({ runtimeDirectory, timeoutMs: 5_000 }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("auto and fixed capture policies remain distinct when attaching", async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000013",
    phase: "failed",
    fps: 60,
    upload: false,
  });
  try {
    const common = {
      recordingId: fixture.state.id,
      runtimeDirectory: fixture.runtimeDirectory,
      width: fixture.state.width,
      height: fixture.state.height,
    };
    const automatic = normalizeOptions(common);
    const fixed = normalizeOptions({ ...common, fps: 60 });

    assert.equal(automatic.capturePolicy.mode, "auto");
    assert.equal(automatic.capturePolicy.targetFps, 60);
    assert.equal(fixed.capturePolicy.mode, "fixed");
    assert.equal(fixed.capturePolicy.targetFps, 60);
    assert.equal(fixed.capturePolicy.processPriority, 10);
    assert.doesNotThrow(() =>
      assertCompatibleSession({ ...fixture.state, capturePolicy: fixed.capturePolicy }, fixed),
    );
    assert.throws(
      () =>
        assertCompatibleSession(
          { ...fixture.state, capturePolicy: automatic.capturePolicy },
          fixed,
        ),
      /different recording configuration/u,
    );
    assert.doesNotThrow(() => assertCompatibleSession(fixture.state, fixed));
  } finally {
    await fixture.cleanup();
  }
});

test("persisted capture policy and media reject invalid values", async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000014",
    phase: "failed",
    fps: 60,
    upload: false,
  });
  const statePath = join(fixture.runtimeDirectory, "session.json");
  try {
    await writeFile(
      statePath,
      `${JSON.stringify({
        ...fixture.state,
        capturePolicy: {
          mode: "auto",
          targetFps: 60,
          encoderPreset: "ultrafast",
          processPriority: 20,
          availableVcpus: 1,
        },
      })}\n`,
    );
    await assert.rejects(readState(fixture.runtimeDirectory), /capture policy state/u);

    await writeFile(
      statePath,
      `${JSON.stringify({
        ...fixture.state,
        media: { measuredFps: 0, frames: 30, durationSeconds: 1 },
      })}\n`,
    );
    await assert.rejects(readState(fixture.runtimeDirectory), /media state/u);

    const configPath = join(fixture.runtimeDirectory, "session-config.json");
    const config = parseObject(await readFile(configPath, "utf8"), "fixture config");
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            ...config,
            capturePolicy: {
              mode: "auto",
              targetFps: 30,
              encoderPreset: "ultrafast",
              processPriority: 10,
              availableVcpus: 1,
            },
          }),
          configPath,
        ),
      /Invalid recording capture policy/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test(
  "recovery returns an existing publication without remuxing or uploading again",
  linuxOnly,
  async () => {
    const fixture = await createFixture({
      recordingId: "00000000-0000-4000-8000-000000000001",
      phase: "uploading_mp4",
      publication: publicationFor("00000000-0000-4000-8000-000000000001"),
    });
    try {
      const result = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });

      assert.equal(result.exists, true);
      if (!result.exists) return;
      assert.equal(result.state.phase, "finished");
      assert.deepEqual(result.state.publication, fixture.publication);
      assert.equal(typeof result.state.browserClosedAt, "string");
    } finally {
      await fixture.cleanup();
    }
  },
);

test("recovery fails instead of finishing without an uploaded MP4", linuxOnly, async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000002",
    phase: "recording",
  });
  try {
    const result = await stopSession({
      runtimeDirectory: fixture.runtimeDirectory,
      timeoutMs: 5_000,
    });

    assert.equal(result.exists, true);
    if (!result.exists) return;
    assert.equal(result.state.phase, "failed");
    assert.match(result.state.failure ?? "", /without an uploaded MP4/u);
    assert.equal(result.state.publication, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("repeated stop retries browser cleanup that was not confirmed", linuxOnly, async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000004",
    phase: "failed",
    publication: publicationFor("00000000-0000-4000-8000-000000000004"),
    failure: "agent-browser cleanup: previous attempt failed",
  });
  try {
    const result = await stopSession({
      runtimeDirectory: fixture.runtimeDirectory,
      timeoutMs: 5_000,
    });

    assert.equal(result.exists, true);
    if (!result.exists) return;
    assert.equal(result.state.phase, "finished");
    assert.equal(typeof result.state.browserClosedAt, "string");
    assert.equal(result.state.failure, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test(
  "repeated stop returns an early startup failure without browser cleanup",
  linuxOnly,
  async () => {
    const fixture = await createFixture({
      recordingId: "00000000-0000-4000-8000-000000000005",
      phase: "failed",
      failure: "FFmpeg readiness timed out",
      browserStartAttempted: false,
      recordingReached: false,
      upload: false,
    });
    try {
      const result = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });

      assert.equal(result.exists, true);
      if (!result.exists) return;
      assert.deepEqual(result.state, fixture.state);
    } finally {
      await fixture.cleanup();
    }
  },
);

test(
  "finalization reports a lower measured FPS instead of rejecting the recording",
  linuxOnly,
  async () => {
    const executableDirectory = await mkdtemp(join(tmpdir(), "sandbox-video-executables-"));
    const ffmpeg = join(executableDirectory, "ffmpeg");
    const ffprobe = join(executableDirectory, "ffprobe");
    const recordingId = "00000000-0000-4000-8000-000000000010";
    await writeExecutable(
      ffmpeg,
      '#!/bin/sh\nfor output do :; done\nif [ "$output" != "-" ]; then printf video > "$output"; fi\n',
    );
    await writeExecutable(
      ffprobe,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"avg_frame_rate":"30/1","nb_frames":"90"}],"format":{"duration":"3"}}\'\n',
    );
    const fixture = await createFixture({
      recordingId,
      phase: "failed",
      failure: "Previous finalization attempt failed",
      fps: 60,
      upload: false,
      executables: { ffmpeg, ffprobe },
    });
    await mkdir(join(fixture.runtimeDirectory, "capture"), { recursive: true });
    await writeFile(join(fixture.runtimeDirectory, "capture", "index.m3u8"), "playlist\n");

    try {
      const result = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });

      assert.equal(result.exists, true);
      if (!result.exists) return;
      assert.equal(result.state.phase, "finished");
      assert.deepEqual(result.state.media, {
        measuredFps: 30,
        frames: 90,
        durationSeconds: 3,
      });
    } finally {
      await fixture.cleanup();
      await rm(executableDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "failed hosted verification remains retryable until publication succeeds",
  linuxOnly,
  async () => {
    const executableDirectory = await mkdtemp(join(tmpdir(), "sandbox-video-executables-"));
    const ffmpeg = join(executableDirectory, "ffmpeg");
    const ffprobe = join(executableDirectory, "ffprobe");
    const uploads = join(executableDirectory, "uploads");
    const recordingId = "00000000-0000-4000-8000-000000000006";
    const publication = publicationFor(recordingId, 5);
    await writeExecutable(
      ffmpeg,
      '#!/bin/sh\nfor output do :; done\nif [ "$output" != "-" ]; then printf video > "$output"; fi\n',
    );
    await writeExecutable(
      ffprobe,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"avg_frame_rate":"30/1","nb_frames":"30"}],"format":{"duration":"1"}}\'\n',
    );
    await writeExecutable(
      uploads,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ key: publication.key, url: publication.url, size: 5 })}'\n`,
    );

    const fixture = await createFixture({
      recordingId,
      phase: "failed",
      failure: "Uploaded MP4 verification failed: HTTP 503",
      executables: { ffmpeg, ffprobe },
      uploadExecutable: uploads,
    });
    await mkdir(join(fixture.runtimeDirectory, "capture"), { recursive: true });
    await writeFile(join(fixture.runtimeDirectory, "capture", "index.m3u8"), "playlist\n");

    const originalFetch = globalThis.fetch;
    let hosted = false;
    globalThis.fetch = async () =>
      new Response(null, {
        status: hosted ? 200 : 503,
        headers: hosted
          ? { "content-type": "video/mp4", "content-length": "5" }
          : { "content-type": "text/plain", "content-length": "0" },
      });
    try {
      const failed = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 1_000,
      });
      assert.equal(failed.exists, true);
      if (!failed.exists) return;
      assert.equal(failed.state.phase, "failed");
      assert.equal(failed.state.publication, undefined);

      hosted = true;
      const recovered = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });
      assert.equal(recovered.exists, true);
      if (!recovered.exists) return;
      assert.equal(recovered.state.phase, "finished");
      assert.deepEqual(recovered.state.publication, publication);
      assert.equal(recovered.state.failure, undefined);

      const repeated = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });
      assert.deepEqual(repeated, recovered);
    } finally {
      globalThis.fetch = originalFetch;
      await fixture.cleanup();
      await rm(executableDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "concurrent callers wait for dead-supervisor recovery and receive one publication",
  linuxOnly,
  async () => {
    const windowManager = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),400));setInterval(()=>{},1000)",
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      windowManager.once("spawn", resolve);
      windowManager.once("error", reject);
    });
    assert.ok(windowManager.pid !== undefined);
    const openbox: OwnedProcessIdentity = {
      pid: windowManager.pid,
      startTimeTicks: await readStartTimeTicks(windowManager.pid),
      executable: process.execPath,
    };
    const fixture = await createFixture({
      recordingId: "00000000-0000-4000-8000-000000000003",
      phase: "uploading_mp4",
      publication: publicationFor("00000000-0000-4000-8000-000000000003"),
      openbox,
    });
    try {
      const [first, second] = await Promise.all([
        stopSession({ runtimeDirectory: fixture.runtimeDirectory, timeoutMs: 5_000 }),
        stopSession({ runtimeDirectory: fixture.runtimeDirectory, timeoutMs: 5_000 }),
      ]);

      for (const result of [first, second]) {
        assert.equal(result.exists, true);
        if (!result.exists) continue;
        assert.equal(result.state.phase, "finished");
        assert.deepEqual(result.state.publication, fixture.publication);
      }
    } finally {
      windowManager.kill("SIGKILL");
      await fixture.cleanup();
    }
  },
);

test("stop retries recovery after the lock holder exits", linuxOnly, async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000009",
    phase: "uploading_mp4",
    publication: publicationFor("00000000-0000-4000-8000-000000000009"),
  });
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),750)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    holder.once("spawn", resolve);
    holder.once("error", reject);
  });
  assert.ok(holder.pid !== undefined);
  const owner: OwnedProcessIdentity = {
    pid: holder.pid,
    startTimeTicks: await readStartTimeTicks(holder.pid),
    executable: process.execPath,
  };
  await writeFile(join(fixture.runtimeDirectory, "recovery.lock"), `${JSON.stringify(owner)}\n`);

  try {
    const result = await stopSession({
      runtimeDirectory: fixture.runtimeDirectory,
      timeoutMs: 3_000,
    });

    assert.equal(result.exists, true);
    if (!result.exists) return;
    assert.equal(result.state.phase, "finished");
    assert.deepEqual(result.state.publication, fixture.publication);
  } finally {
    holder.kill("SIGKILL");
    await fixture.cleanup();
  }
});

interface FixtureOptions {
  readonly recordingId: string;
  readonly phase: RecordingSessionPhase;
  readonly publication?: UploadsPublication;
  readonly openbox?: OwnedProcessIdentity;
  readonly failure?: string;
  readonly fps?: 30 | 60;
  readonly browserStartAttempted?: boolean;
  readonly recordingReached?: boolean;
  readonly upload?: boolean;
  readonly executables?: RecordingExecutables;
  readonly uploadExecutable?: string;
}

async function createFixture(options: FixtureOptions): Promise<{
  readonly runtimeDirectory: string;
  readonly publication?: UploadsPublication;
  readonly state: RecordingSessionState;
  cleanup(): Promise<void>;
}> {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "sandbox-video-recovery-"));
  const now = new Date().toISOString();
  const config = {
    id: options.recordingId,
    runtimeDirectory,
    width: 1280,
    height: 720,
    fps: options.fps ?? 30,
    segmentDurationSeconds: 10,
    initialUrl: "about:blank",
    startupTimeoutMs: 30_000,
    stopTimeoutMs: 15_000,
    executables: {
      agentBrowser: "/usr/bin/true",
      ffmpeg: "must-not-run-ffmpeg",
      ffprobe: "must-not-run-ffprobe",
      mcookie: "mcookie",
      openbox: "openbox",
      xauth: "xauth",
      xdpyinfo: "xdpyinfo",
      xprop: "xprop",
      xvfb: "Xvfb",
      ...options.executables,
    },
    ...(options.upload === false
      ? {}
      : {
          upload: {
            key: `screenshots/sandbox-video/${options.recordingId}/proof.mp4`,
            executable: options.uploadExecutable ?? "must-not-run-uploads",
          },
        }),
  };
  const state: RecordingSessionState = {
    schemaVersion: 1,
    id: options.recordingId,
    phase: options.phase,
    runtimeDirectory,
    display: ":65000",
    xauthorityPath: join(runtimeDirectory, "Xauthority"),
    displayLockPath: "/tmp/sandbox-video-display-65000.lock",
    playlistPath: join(runtimeDirectory, "capture", "index.m3u8"),
    segmentPattern: join(runtimeDirectory, "capture", "segment-%06d.ts"),
    finalMp4Path: join(runtimeDirectory, "recording.mp4"),
    supervisorLogPath: join(runtimeDirectory, "supervisor.log"),
    agentBrowserSession: `sv-${options.recordingId.slice(-12)}`,
    agentBrowserNamespace: `sv-${options.recordingId.slice(-12)}`,
    width: config.width,
    height: config.height,
    fps: config.fps,
    segmentDurationSeconds: config.segmentDurationSeconds,
    supervisor: {
      pid: 2_147_483_647,
      startTimeTicks: "1",
      executable: process.execPath,
    },
    ...(options.openbox === undefined ? {} : { openbox: options.openbox }),
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
    ...(options.browserStartAttempted === false ? {} : { browserStartAttemptedAt: now }),
    phaseHistory: [
      { phase: "starting", at: now },
      ...(options.recordingReached === false ? [] : [{ phase: "recording" as const, at: now }]),
      ...(options.phase === "recording" ? [] : [{ phase: options.phase, at: now }]),
    ],
    startedAt: now,
    updatedAt: now,
  };
  await writeFile(join(runtimeDirectory, "session-config.json"), `${JSON.stringify(config)}\n`);
  await writeFile(join(runtimeDirectory, "session.json"), `${JSON.stringify(state)}\n`);
  return {
    runtimeDirectory,
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    state,
    cleanup: () => rm(runtimeDirectory, { recursive: true, force: true }),
  };
}

function publicationFor(recordingId: string, sizeBytes = 1_024): UploadsPublication {
  const key = `screenshots/sandbox-video/${recordingId}/proof.mp4`;
  return {
    key,
    url: `https://storage.uploads.sh/example/${key}`,
    contentType: "video/mp4",
    sizeBytes,
  };
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function readStartTimeTicks(pid: number): Promise<string> {
  const source = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = source.lastIndexOf(")");
  assert.ok(closing >= 0);
  const value = source
    .slice(closing + 1)
    .trim()
    .split(/\s+/u)[19];
  assert.match(value ?? "", /^\d+$/u);
  return value!;
}

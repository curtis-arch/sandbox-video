# sandbox-video

`sandbox-video` records the headed browser while an AI coding agent works inside
a Vercel Sandbox. It aims for 60 FPS when the machine has room, backs off when
the agent needs the CPU, and publishes one browser-compatible MP4 through
[`uploads.sh`](https://uploads.sh).

The CLI works alongside
[`agent-browser`](https://github.com/vercel-labs/agent-browser). It leaves the
automation protocol alone. agent-browser's built-in recorder samples one JPEG
every 100 ms; `sandbox-video` records the rendered display directly, which
keeps motion smooth enough to catch brief visual bugs.

> Published on npm as [`sandbox-video`](https://www.npmjs.com/package/sandbox-video).

## See it in action

[Watch a 24-second 1920×1080 recording at 60 FPS](./docs/assets/sandbox-video-demo.mp4).
The CLI captured the animated test rig through the same headed agent-browser
session used by the coding agent, then finalized and uploaded the MP4 during
`stop`.

## Agent workflow

The coding agent is already running inside the Vercel Sandbox:

```text
start -> use returned agent-browser command -> status -> stop -> uploads.sh URL
```

Start recording on the page you want to validate:

```sh
sandbox-video start \
  --url http://127.0.0.1:3000 \
  --size 1920x1080
```

Startup waits up to 30 seconds for the browser and FFmpeg capture to become
ready. Use `--startup-timeout-ms` to adjust that window for a slower Sandbox.
If startup times out, the CLI stops the detached supervisor and its owned
processes before returning the failure.

You normally do not need to set `--fps`. Its default, `auto`, targets 60 FPS,
uses `ultrafast` on a 1-vCPU Sandbox, and uses `veryfast` on larger machines.
FFmpeg runs at Linux priority 10, so the agent gets CPU time first when both are
busy. Pass `--fps 30` or `--fps 60` only when you want a fixed ceiling.

The measured rate can fall below the target on a busy machine. That is useful
data, not a failed recording. `start`, `status`, and `stop` report the chosen
`capturePolicy`. After finalization, `stop` also reports `measuredFps`,
`frames`, and `durationSeconds`.

### Measured Vercel Sandbox performance

These runs used 1920×1080, CRF 12, H.264/yuv420p, and a 60 FPS target. The table
reports medians from successful runs. Treat them as a guide; different builds
and Sandbox hosts will move the numbers around.

| Vercel Sandbox | Auto preset | Median measured FPS                                            |
| -------------- | ----------- | -------------------------------------------------------------- |
| 1 vCPU / 2 GB  | `ultrafast` | 60 idle; 16.3 during four repeated TypeScript builds           |
| 2 vCPU / 4 GB  | `veryfast`  | 60 idle; 53.2 during four repeated TypeScript builds           |
| 4 vCPU / 8 GB  | `veryfast`  | 60 idle and with 256 MB plus 70% of one CPU in background load |
| 8 vCPU / 16 GB | `veryfast`  | 60 idle and with 256 MB plus 70% of one CPU in background load |

A 1-vCPU box is tight, but it still records. Four builds took a 6.4-second
median with no recorder and 9.25 seconds with auto enabled. The old
normal-priority `veryfast` setup took 21.2 seconds. On 2 vCPU, auto reduced the
recorded build median from 9.40 to 6.89 seconds and kept 53.2 FPS.

The CLI opens `--url` before FFmpeg starts. This keeps browser startup and the
black X11 root window out of the recording. If `--url` is omitted, the browser
opens `about:blank`.

`sandbox-video --help` gives an agent the complete JSON command contract:
parameters, return fields, exit codes, prerequisites, and the required order of
operations. `sandbox-video start --help`, `status --help`, and `stop --help`
return the contract for one command.

Every successful command writes one stable envelope to stdout and leaves
stderr empty, except that `stop` emits progress events on stderr. A failed
command leaves stdout empty and writes one JSON error envelope to stderr:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "status": "recording",
    "recordingId": "865a5385-54c0-4efa-8b61-5013e6391737",
    "fps": 60,
    "capturePolicy": {
      "mode": "auto",
      "targetFps": 60,
      "encoderPreset": "veryfast",
      "processPriority": 10,
      "availableVcpus": 2
    },
    "agentBrowserCommand": [
      "agent-browser",
      "--namespace",
      "sv-865a538554c04efa",
      "--session",
      "sv-865a538554c04efa"
    ]
  },
  "meta": {
    "cliVersion": "0.2.0",
    "command": "start",
    "effect": "recording-started"
  }
}
```

The agent must reuse every argument in `agentBrowserCommand`:

```sh
agent-browser \
  --namespace sv-865a538554c04efa \
  --session sv-865a538554c04efa \
  snapshot

agent-browser \
  --namespace sv-865a538554c04efa \
  --session sv-865a538554c04efa \
  click @e2
```

Inspect live progress without changing the recording:

```sh
sandbox-video status \
  --recording-id 865a5385-54c0-4efa-8b61-5013e6391737
```

Finalize and publish:

```sh
sandbox-video stop \
  --recording-id 865a5385-54c0-4efa-8b61-5013e6391737
```

`stop` reports five newline-delimited JSON progress events on stderr so an
agent knows work is continuing:

```json
{"schemaVersion":1,"type":"progress","command":"stop","recordingId":"865a5385-54c0-4efa-8b61-5013e6391737","step":1,"totalSteps":5,"phase":"closing_browser"}
{"schemaVersion":1,"type":"progress","command":"stop","recordingId":"865a5385-54c0-4efa-8b61-5013e6391737","step":2,"totalSteps":5,"phase":"stopping_capture"}
```

Its one stdout JSON object contains the terminal status, hosted URL, storage
key, content type, byte size, measured frame rate, frame count, and duration.
Repeating `stop` returns the same terminal result without recording, probing,
or uploading again.

## Runtime ownership

`start` launches one detached supervisor. The supervisor owns:

- one Xvfb display and Xauthority file;
- one openbox window manager;
- one FFmpeg `x11grab` capture;
- one short agent-browser namespace/session pair; and
- durable state under `/tmp/sandbox-video/<recording-id>`.

The browser is headed even though the Vercel Sandbox has no physical monitor.
Xvfb is the virtual monitor, openbox manages its windows, agent-browser drives
Chrome on that display, and FFmpeg records the same display. The agent does not
need to choose a display or separately declare headed mode.

`status` and `stop` reconnect through the recording ID. Process identity uses
both PID and Linux `/proc` start time so a recycled PID is never treated as an
owned process.

The supervisor stores local HLS segments while recording. On explicit stop it
closes Chrome, drains FFmpeg, stream-copy remuxes the playlist with `+faststart`
to a temporary MP4, verifies its codec, pixel format, geometry, positive
measured frame rate, frame count, duration, and full decode, then atomically
installs and uploads the final MP4. The measured frame rate does not have to
equal the requested rate. The CLI verifies the hosted content type and byte
length before returning the URL and removes the owned processes. HLS is an
internal crash recovery format, not a public artifact.

## Requirements inside the Sandbox

- Node.js 24 or later
- FFmpeg with `x11grab` and `libx264`, plus ffprobe
- `nice` from GNU coreutils
- Xvfb, openbox, xauth, mcookie, xdpyinfo, and xprop
- agent-browser and its Chromium installation
- uploads.sh CLI 0.48.0 or later, authenticated with `uploads login`

uploads.sh reads its normal shared configuration from
`$XDG_CONFIG_HOME/buildinternet/config` or
`$HOME/.config/buildinternet/config`. `--uploads-workspace` is available as an
explicit override; it is not required when the saved config selects a
workspace.

Build and install from this repository inside a prepared Sandbox image:

```sh
pnpm install --frozen-lockfile
pnpm build
npm install --global .
```

Install the published CLI inside a prepared Sandbox image:

```sh
npm install --global sandbox-video@0.2.0
```

An agent can instead use `npx --yes sandbox-video@0.2.0 <command>`. Pin the
same exact version for `start`, `status`, and `stop`. There is intentionally no
self-update command or automatic update check: npm/npx owns installation, and
the response schema must not change in the middle of a recording lifecycle.

No Vercel SDK, Vercel Blob store, snapshot creation, or sidecar Sandbox is part
of the runtime package. Provisioning the Sandbox and installing dependencies
remain the responsibility of the coding environment.

## Encoding profile

v2 writes one MP4 that can go straight into a pull request. Capture performs
the only encode. Finalization remuxes the HLS segments without re-encoding:

```sh
nice -n 10 ffmpeg \
  -f x11grab -framerate FPS -video_size WIDTHxHEIGHT -i DISPLAY.0 \
  -an -c:v libx264 -preset PRESET -crf 12 -pix_fmt yuv420p \
  -fps_mode passthrough -g $((FPS * 2)) -keyint_min $((FPS * 2)) \
  -sc_threshold 0 \
  -force_key_frames 'expr:gte(t,n_forced*SEGMENT_SECONDS)' \
  -f hls -hls_time SEGMENT_SECONDS -hls_list_size 0 \
  -hls_segment_type mpegts -hls_flags independent_segments+temp_file \
  -hls_segment_filename 'segment-%06d.ts' index.m3u8

ffmpeg -i index.m3u8 -c copy -movflags +faststart recording.mp4
```

`PRESET` is `ultrafast` on 1 vCPU and `veryfast` on larger Sandboxes. FFmpeg
runs at Linux process priority 10. It can use the whole machine while the agent
is idle, then yield when a build or test starts.

The [encoding quality study](./benchmarks/encoding-quality/README.md) also
tested CRF 23/4:2:0, CRF 23/4:4:4, CRF 16/4:4:4, CRF 14/4:4:4, CRF 12/4:4:4,
and a high-quality RGB reference. The results showed that 4:4:4 preserves
colored UI edges better, but hosted Chrome did not play those files reliably. The v1
pipeline therefore produced separate 4:4:4 evidence and 4:2:0 share files.

v2 uses one CRF 12/4:2:0 artifact. There is no second encode, finalization is
shorter, and the agent gets one URL that plays in browsers and GitHub PRs. The
benchmark stays in the repository with the data behind that choice.

## Real Sandbox verification

The interactive React fixture lives in
[`benchmarks/recording-test-rig`](./benchmarks/recording-test-rig). It is a
benchmark, not shipped npm code.

On September 1, 2026, the auto policy passed all 18 package tests on fresh
1-vCPU and 2-vCPU Vercel Sandboxes. End-to-end capture confirmed Linux priority
10 from `/proc`. The 1-vCPU machine produced 60 FPS while idle and 16.35 FPS
while running four builds, which completed in 9.52 seconds. The 2-vCPU machine
produced 52.32 FPS during the same workload, which completed in 6.89 seconds.
Every recording decoded successfully. These private verification runs did not
upload their MP4s.

On August 26, 2026, the release candidate passed all 14 package tests inside a
4-vCPU Vercel Sandbox. The Linux-only cases cover concurrent stop calls,
dead-supervisor recovery, browser-cleanup retry, publication-verification retry,
idempotent terminal results, and the browser-before-FFmpeg startup order.

The v0.1.2 verification opened the target page before capture, interacted with
it through the returned agent-browser session, and confirmed that live capture
advanced from frame 116 to frame 221. The
[hosted proof](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/3aa7e879-bbcd-422d-a085-e90219c52220/proof.mp4)
contains 271 frames at exactly 60 FPS. Its first-frame average luma was 224.2,
and FFmpeg detected no black interval at the start.

The same run installed the CLI, built the React fixture, and used its returned
agent-browser session to start the timer, change animation timing, flash the
grid, and click targets. The [hosted proof](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/dc91b072-1a2b-4679-81b8-c8b1b8f1c375/proof.mp4)
is also retained as the repository-owned [demo video](./docs/assets/sandbox-video-demo.mp4).

Sandbox-side `ffprobe` reported H.264 High, `yuv420p`, 1920×1080, 1,472 frames,
24.533 seconds, and exact 60/1 average and nominal frame rates. The MP4 was
2,252,068 bytes. Its hosted `HEAD` response returned HTTP 200,
`Content-Type: video/mp4`, the same content length, and byte-range support. A
repeated `stop` returned the same publication, no recording-owned process
remained, and the Sandbox was explicitly stopped.

## Failure and durability boundary

The CLI uses four exit codes:

| Exit | Meaning                                                   |
| ---: | --------------------------------------------------------- |
|  `0` | Command completed; for `stop`, the final MP4 is uploaded  |
|  `2` | Invalid command, option, or recording ID                  |
|  `4` | Startup, capture, finalization, upload, or cleanup failed |
| `20` | Recording ID does not exist in this Sandbox filesystem    |

The current uploads.sh integration publishes only after explicit `stop`. Local
HLS segments can recover from a supervisor failure while the Sandbox filesystem
still exists, but they do not survive abrupt Sandbox destruction. The caller
must reserve enough Sandbox lifetime to run `stop` and wait for its terminal
JSON result.

The CLI does not upload chunks while recording. That would require storage that
can accept partial video and assemble it safely. For now, an abruptly destroyed
Sandbox can still take its local HLS segments with it.

Every process running as the same Sandbox user can reach the uploads.sh token,
whether it came from the environment or the shared config file. Do not run
untrusted code in the recording Sandbox. Isolating that credential would
require a separate uploader.

## Development

```sh
pnpm check
pnpm build
pnpm test
pnpm pack --dry-run
```

The npm tarball contains only the CLI runtime, uploads.sh adapter, README,
agent skill, and license. The benchmark applications and historical quality
artifacts remain in GitHub but are not distributed with the package.

## License

[MIT](./LICENSE) © 2026 John Curtis

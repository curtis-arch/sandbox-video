# sandbox-video

`sandbox-video` records the headed browser used by an AI coding agent inside a
Vercel Sandbox. It captures the shared X11 display with FFmpeg at 30 or 60 FPS,
then publishes one browser-compatible MP4 through
[`uploads.sh`](https://uploads.sh).

The CLI complements
[`agent-browser`](https://github.com/vercel-labs/agent-browser); it does not
fork it or replace its automation protocol. agent-browser's built-in video
recorder samples one JPEG every 100 ms. This project captures the rendered
display directly, so smooth motion and short visual defects remain observable.

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
  --fps 60 \
  --size 1920x1080
```

Startup waits up to 30 seconds for the browser and FFmpeg capture to become
ready. Use `--startup-timeout-ms` to adjust that window for a slower Sandbox.
If startup times out, the CLI stops the detached supervisor and its owned
processes before returning the failure.

The CLI opens `--url` before FFmpeg starts. This keeps browser startup and the
black X11 root window out of the recording. If `--url` is omitted, the browser
opens `about:blank`.

`sandbox-video --help` is the runtime contract for an agent. It writes a JSON
manifest containing commands, typed parameters, effects, exit codes, the exact
workflow, prerequisites, and the update policy. `sandbox-video start --help`,
`status --help`, and `stop --help` return the contract for one command.

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
    "agentBrowserCommand": [
      "agent-browser",
      "--namespace",
      "sv-865a538554c04efa",
      "--session",
      "sv-865a538554c04efa"
    ]
  },
  "meta": {
    "cliVersion": "0.1.2",
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
key, content type, and byte size. Repeating `stop` returns the same terminal
result without recording or uploading again.

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
to a temporary MP4, verifies its codec, pixel format, geometry, frame rate,
frame count, duration, and full decode, then atomically installs and uploads the
final MP4. It verifies the hosted content type and byte length before returning
the URL and removes the owned processes. HLS is an internal crash recovery
format, not a public artifact.

## Requirements inside the Sandbox

- Node.js 24 or later
- FFmpeg with `x11grab` and `libx264`, plus ffprobe
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
npm install --global sandbox-video@0.1.2
```

An agent can instead use `npx --yes sandbox-video@0.1.2 <command>`. Pin the
same exact version for `start`, `status`, and `stop`. There is intentionally no
self-update command or automatic update check: npm/npx owns installation, and
the response schema must not change in the middle of a recording lifecycle.

No Vercel SDK, Vercel Blob store, snapshot creation, or sidecar Sandbox is part
of the runtime package. Provisioning the Sandbox and installing dependencies
remain the responsibility of the coding environment.

## Encoding profile

The current v2 product creates one pull-request-ready output. Capture performs
the only encode; finalization remuxes without re-encoding:

```sh
ffmpeg -f x11grab -framerate FPS -video_size WIDTHxHEIGHT -i DISPLAY.0 \
  -an -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p \
  -fps_mode passthrough -g $((FPS * 2)) -keyint_min $((FPS * 2)) \
  -sc_threshold 0 \
  -force_key_frames 'expr:gte(t,n_forced*SEGMENT_SECONDS)' \
  -f hls -hls_time SEGMENT_SECONDS -hls_list_size 0 \
  -hls_segment_type mpegts -hls_flags independent_segments+temp_file \
  -hls_segment_filename 'segment-%06d.ts' index.m3u8

ffmpeg -i index.m3u8 -c copy -movflags +faststart recording.mp4
```

The [encoding quality study](./benchmarks/encoding-quality/README.md) also
tested CRF 23/4:2:0, CRF 23/4:4:4, CRF 16/4:4:4, CRF 14/4:4:4, CRF 12/4:4:4,
and a high-quality RGB reference. It established that 4:4:4 preserves colored
UI edges better, but hosted Chrome did not play those files reliably. The v1
pipeline therefore produced separate 4:4:4 evidence and 4:2:0 share files.

v2 deliberately selects one CRF 12/4:2:0 artifact. That removes a second encode,
cuts finalization time, and gives an agent one URL that plays in browsers and
GitHub PRs. The benchmark remains in the repository so this tradeoff is not
mistaken for an untested default.

## Real Sandbox verification

The interactive React fixture lives in
[`benchmarks/recording-test-rig`](./benchmarks/recording-test-rig). It is a
benchmark, not shipped npm code.

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

Exit codes are intentionally small:

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

Progressive remote chunk persistence is intentionally deferred until the
project owns a storage service that can accept chunks and assemble them
atomically. v2 does not claim protection it does not provide.

The uploads.sh token is available to processes running as the same Sandbox user,
whether supplied through the environment or the shared config file. Do not run
untrusted code in the recording Sandbox. Strong credential isolation requires
an uploader outside that trust boundary and is not part of this simplified
single-Sandbox design.

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

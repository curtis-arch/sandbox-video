---
name: sandbox-video
description: Record the final headed agent-browser validation inside a Vercel Sandbox and return an uploads.sh proof URL or a local MP4 path.
---

# sandbox-video

Use this skill only inside a prepared Vercel Sandbox. The CLI controls the
recording lifecycle; `agent-browser` controls the browser.

1. Run `sandbox-video --help` and parse its JSON response.
2. Run `sandbox-video start --url <target> --size 1920x1080`. Leave `--fps` at
   its `auto` default unless the user requests a fixed 30 or 60 FPS ceiling.
   The CLI opens the target before capture starts, so use the page you want in
   the first video frame. Add `--upload none` when the user wants the MP4 kept
   on this machine instead of uploaded.
3. Retain `data.recordingId`, `data.upload`, and the complete
   `data.agentBrowserCommand` array. `data.upload` decides what `stop` delivers.
4. Append each `agent-browser` action to that exact command array. Do not create
   a different namespace or session.
5. Run `sandbox-video status --recording-id <id>` and confirm
   `data.capture.frame` increases during validation. If the agent is saturating
   the machine, wait and check again instead of treating one stalled sample as
   recording failure.
6. Run `sandbox-video stop --recording-id <id>` once. Progress is NDJSON on
   stderr. Wait for exit 0 before ending the Sandbox. Treat
   `data.measuredFps` as recording telemetry, not a success threshold.
   - `uploads.sh`: the proof is the hosted MP4 at `data.url`.
   - `none`: the proof is the verified local MP4 at `data.path`, which is gone
     when the Sandbox ends. Copy it out or attach it first, for example
     `gh pr comment <pr> --attach "<data.path>" --body "<what the video shows>"`
     ([docs](https://cli.github.com/manual/gh_pr_comment); a video takes no alt
     text). GitHub
     [caps attached videos](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
     at 10 MB on free plans and 100 MB on paid plans; compare with
     `data.sizeBytes`.

On success, stdout contains one JSON envelope and data is under `data`. On
failure, stdout is empty and stderr contains one JSON error envelope; read
failure details from `error`. When `error.artifact` is present, its `path` is a
verified MP4 that is usable on its own although the upload or cleanup failed.
During `stop`, stderr contains NDJSON progress events before any failure
envelope. Contract metadata is under `meta`. Exit 2
means invalid input, exit 4 means the operation failed, and exit 20 means the
recording does not exist in this Sandbox.

Pin the same exact package version for `start`, `status`, and `stop`. The CLI
never updates itself.

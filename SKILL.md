---
name: sandbox-video
description: Record the final headed agent-browser validation inside a Vercel Sandbox and return an uploads.sh proof URL.
---

# sandbox-video

Use this skill only inside a prepared Vercel Sandbox. The CLI controls the
recording lifecycle; `agent-browser` controls the browser.

1. Run `sandbox-video --help` and parse its JSON response.
2. Run `sandbox-video start --url <target> --size 1920x1080`. Leave `--fps` at
   its `auto` default unless the user requests a fixed 30 or 60 FPS ceiling.
   The CLI opens the target before capture starts, so use the page you want in
   the first video frame.
3. Retain `data.recordingId` and the complete `data.agentBrowserCommand` array.
4. Append each `agent-browser` action to that exact command array. Do not create
   a different namespace or session.
5. Run `sandbox-video status --recording-id <id>` and confirm
   `data.capture.frame` increases during validation. If the agent is saturating
   the machine, wait and check again instead of treating one stalled sample as
   recording failure.
6. Run `sandbox-video stop --recording-id <id>` once. Progress is NDJSON on
   stderr. Wait for exit 0 and `data.url` on stdout before ending the Sandbox.
   Treat `data.measuredFps` as recording telemetry, not a success threshold.

On success, stdout contains one JSON envelope and data is under `data`. On
failure, stdout is empty and stderr contains one JSON error envelope; read
failure details from `error`. During `stop`, stderr contains NDJSON progress
events before any failure envelope. Contract metadata is under `meta`. Exit 2
means invalid input, exit 4 means the operation failed, and exit 20 means the
recording does not exist in this Sandbox.

Pin the same exact package version for `start`, `status`, and `stop`. The CLI
never updates itself.

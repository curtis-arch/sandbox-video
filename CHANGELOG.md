# Changelog

## [0.3.0] - 2026-09-29

### Added

- Use `start --upload none` to save a verified MP4 on the recording machine.
  No uploads.sh installation or credentials are needed.
- Set `SANDBOX_VIDEO_UPLOAD=none` to make local recording the default for your
  environment. An explicit `--upload` flag overrides it.
- Read the MP4's absolute `path`, `contentType`, and `sizeBytes` from the
  command output after finalization. An agent can use the path to attach the
  video to GitHub or copy it elsewhere.

### Fixed

- Preserve verified MP4 metadata and recording phase history when an upload
  fails. Failed `stop` and `status` responses include `error.artifact` so the
  caller can still use the local file.

Uploads.sh remains the default. Local files stay on the recording machine, so
copy or attach them before ending an ephemeral Sandbox.

## [0.2.0] - 2026-09-01

### Added

- Added the default `--fps auto` mode. It targets 60 FPS, chooses an encoder
  preset from the Sandbox CPU count, and gives agent work priority when CPU is
  tight.
- Added `capturePolicy`, `measuredFps`, `frames`, and `durationSeconds` to the
  command output so agents can report what the recording actually produced.

### Fixed

- Kept valid recordings when CPU pressure lowers their measured frame rate.
  Finalization still checks H.264, pixel format, geometry, frame count,
  duration, and a full decode.

### Changed

- Updated the agent instructions and README with automatic-mode guidance and
  measured results from 1, 2, 4, and 8-vCPU Vercel Sandboxes.

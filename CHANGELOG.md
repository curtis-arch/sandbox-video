# Changelog

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

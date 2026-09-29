# Local recording (`--upload none`)

Request (Ahmed): a flag to skip uploads.sh and keep the MP4 local; `gh` now
attaches local video to PRs. uploads.sh stays the default. S3/R2 is a later
release, not this change.

## Contract

- `start --upload uploads.sh|none`. Precedence: flag > `SANDBOX_VIDEO_UPLOAD` >
  `uploads.sh`. Resolved once at start and persisted through the existing
  optional upload config: an upload object means uploads.sh, no object means
  none. `status`/`stop` derive `data.upload` from that stored config, never from
  the current environment.
- Invalid flag or env value: exit 2. Explicit `--uploads-workspace` with
  effective none: exit 2. Ambient `UPLOADS_WORKSPACE` is ignored for none.
- Once verified: `path` (absolute), `contentType: "video/mp4"`, `sizeBytes`,
  plus the existing media fields. `url`/`key` appear only after an upload.
  `meta.effect` is `proof-uploaded` (unchanged) or `proof-saved`. JSON stays
  schema v1; all fields are additive.
- `stop` progress: five steps for uploads.sh (unchanged), four for none.
- Failed `stop`/`status`: exit 4, stderr envelope, empty stdout, plus optional
  `error.artifact {path, contentType, sizeBytes}` when a verified MP4 exists.
  `retryable` and repeat-stop recovery are unchanged.
- `path` records that the file was verified, not that it still exists later.

## Fixed alongside

Upload failure used to erase verified media from durable state. The upload
error propagated out of `produceAndPublishMp4`, so `finalizeRecording` wrote its
older `stopping_capture` snapshot at `cleaning_up`, dropping `media` and the
`finalizing_mp4`/`uploading_mp4` history. Finalization and publishing are now
separate steps that each return their latest state.

## Deferred

`--output`, S3/R2 providers, a provider registry or interface, a standalone
publish command, reusing the verified MP4 on upload retry, `retryable` policy
changes, and non-Linux support. Future providers still need adapter and config
additions; the local-file contract above should not need to change.

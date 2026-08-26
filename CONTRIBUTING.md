# Contributing

Thanks for helping improve `sandbox-video`.

## Development setup

Use Node.js 24 or later and the pnpm version declared in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm pack --dry-run
```

The two standalone benchmark applications intentionally keep npm lockfiles
because they are copied and installed independently inside the universal
Vercel Sandbox image. The root CLI package uses pnpm.

The published package has no runtime npm dependencies. Keep provider SDKs and
benchmark dependencies out of the CLI unless its runtime genuinely needs them.

## Lint

`pnpm lint` runs oxlint with `--deny-warnings`. Cyclomatic complexity is capped
at 15 for `src/` (`eslint/complexity`). That is stricter than oxlint's default
of 20 and looser than 12, which starts punishing linear validation (`??`, `?.`,
and optional JSON fields) instead of real branching. Extract a helper when a
function grows a new independent path; do not disable the rule.

## Project boundaries

- The CLI runs inside an existing Vercel Sandbox. It does not provision one.
- agent-browser remains upstream; this project owns display capture and final
  publication only.
- Capture and transcoding verification must run in Vercel Sandbox. Local media
  analysis is acceptable, but it is not runtime-equivalent proof.
- uploads.sh is the only current publication backend. Add another adapter only
  with a concrete product requirement and real-boundary verification.
- Standard output is machine-readable JSON. Progress and diagnostics belong on
  standard error.
- Never print, persist, or commit upload credentials.

## Tests

Permanent tests must protect a stable contract or a realistic regression.
Prefer one real Vercel Sandbox lifecycle verification over large mock suites.
Do not add a test framework, fixture server, or CI service as a side effect of
an unrelated change.

For runtime changes, record the exact Sandbox versions and verify the closest
real boundary: start, agent-browser interaction, advancing frame counters,
stop, final media validation, hosted object response, and process cleanup.

## Pull requests

Keep changes focused. Explain the user-visible behavior, the failure mode being
prevented, and the verification performed. Update the root README when the CLI,
encoding profile, installation path, or durability boundary changes.

## Releases

The version in `package.json` and the GitHub release tag must match. A release
for package version `1.2.3` therefore uses tag `v1.2.3`.

Pushing a `v*` tag runs `.github/workflows/publish.yml`. The workflow installs
the pinned pnpm dependencies, runs `pnpm check` and `pnpm test`, checks the tag,
and publishes through npm trusted publishing. npm uses GitHub's OIDC identity
for that one run, so the repository does not store an npm write token. Publish
the matching GitHub Release after the workflow succeeds.

The workflow also has a manual recovery trigger for rerunning an unpublished
version. Supply the existing version tag as `release_tag`. Do not bump or reuse
the version just to retry a failed workflow.

Do not run `npm publish` from a development machine for routine releases. If a
publish job fails, fix the cause and rerun that job. Never reuse a version that
npm already accepted.

# STATE

## Current increment
0 — Scaffold and the verification harness

## Done in this increment
- Repo restructured: starter kit moved to the repo root, zip removed (D-008).
- Spec renamed to `spec/core-semantic-model.md`, content unchanged; operator confirmed it is final v0.5.1 (D-009).
- TypeScript 6.0 strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (D-010).
- Vitest test runner; `npm run test:watch` is watch mode (D-010).
- Zod 4 wired at the runner's environment boundary through `parseAtBoundary` (D-011).
- Lint rule `juno/no-shell` with tests, including the deliberately added `exec()` probe. Inline disable comments are switched off repo-wide (D-012).

## Remaining in this increment
- `containers/runner.Dockerfile`, `containers/workload.Dockerfile`, `containers/docker-compose.yml` — both images build; `docker compose up` runs and exits cleanly
- Workload image has no shell, runs non-root, no network
- `Makefile` with `make verify`: typecheck → lint → unit tests → container build
- CI (`.github/workflows/verify.yml`) passes on the increment's pull request

## make verify
NOT YET RUNNABLE — no Makefile exists. Increment 0 creates it.

## Open objections to the spec
- None

## Notes for the next session
- Confirm `spec/core-semantic-model.md` (v0.5.1) is present before starting. If missing, stop and tell the operator.
- Read DECISIONS.md D-001 (no network in Docker builds) before writing the Dockerfiles.

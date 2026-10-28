# STATE

## Current increment
0 — Scaffold and the verification harness

## Done in this increment
- Repo restructured: starter kit moved to the repo root, zip removed (D-008).
- Spec renamed to `spec/core-semantic-model.md`, content unchanged; operator confirmed it is final v0.5.1 (D-009).

## Remaining in this increment
- TypeScript strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Test runner with watch mode
- Runtime schema library chosen and wired at boundaries (record the choice in DECISIONS.md)
- Lint rule banning `child_process.exec`, `execSync`, `shell: true`, template-literal command construction — with a test proving it fails a deliberately added `exec()` call
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

# STATE

## Current increment
0 — Scaffold and the verification harness

## Done in this increment
- Repo restructured: starter kit moved to the repo root, zip removed (D-008).
- Spec renamed to `spec/core-semantic-model.md`, content unchanged; operator confirmed it is final v0.5.1 (D-009).
- TypeScript 6.0 strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (D-010).
- Vitest test runner; `npm run test:watch` (or `make test-watch`) is watch mode (D-010).
- Zod 4 wired at the runner's environment boundary through `parseAtBoundary` (D-011).
- Lint rule `juno/no-shell`, tested against a deliberately added `exec()` call and 20 other bypass and allowed cases. Inline disable comments are switched off repo-wide, and `make lint` re-proves the rule through the real ESLint CLI on every run (D-012).
- `containers/runner.Dockerfile`, `containers/workload.Dockerfile`, `containers/docker-compose.yml`. Both images build with no network access, and `docker compose up` exits 0 for both services (D-001, D-013).
- The workload is checked in its running container: no shell file in its filesystem, non-root, zero Linux capabilities, loopback only, no journal mount (D-013).
- `Makefile`: `make verify` runs typecheck, lint (plus lint self-test), unit tests, then container build and container checks.
- Mutation-checked: switching the lint rule off fails 23 lint tests. Giving the workload root, a network, capabilities and the journal mount fails 6 container tests. Pointing the shell checks at the runner image (which has a shell) fails them.

## Remaining in this increment
- CI (`.github/workflows/verify.yml`) must pass on the increment's pull request. That is the last done-when item.

## make verify
GREEN as of 2026-10-28 (local cloud session): 38 unit tests, 14 container tests, lint self-test rejected the `exec()` probe.

## Open objections to the spec
- None

## Notes for the next session
- The workload's named volume `work-vol` is root-owned when first created. Writing to it as user 65532 is Increment 2/3 work. The fix is to own the mount point in the image (`COPY --chown`), because distroless has no shell for `RUN`.
- The runner has `network_mode: none` until Increment 5 adds the provider (D-013).
- Production dependencies for the images are staged on the host in `build/stage` (`make stage`). Never add `npm install` to a Dockerfile (D-001).
- Cloud sessions here are pinned to a session branch, but pushing `inc-0-scaffold` worked. Keep using `inc-<N>-<name>` branches.
- `docs/cloud-environment-setup.sh` pre-pulls the same two base images. If D-013's image digests change, update both.

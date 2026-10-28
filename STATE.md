# STATE

## Current increment
1 — Contracts and the lattice

Branch: `inc-1-contracts-lattice`. Increment 0 is merged into `main` (its commits reached `main` through PR #2).

## Done in this increment
- `fast-check` 4.10.2 added as a dev dependency for the property-based join tests.
- In progress, not yet tested: `packages/contracts/src/` — `lattice.ts`, `common.ts`, `capability.ts`, `interpreter.ts`, `reference.ts`, `provenance.ts`, `grant.ts`, `attenuation.ts`.

## Remaining in this increment
- Task, TrajectoryEntry, Closure, Artifact schemas.
- Tests for every Increment 1 property, then `make verify`.
- DECISIONS.md entries D-015 onward.
- The accept half of the attenuation check is blocked on objection O-1 below.

## make verify
Not yet run on this branch.

## Open objections to the spec
- **O-1 — §3.2 "strict subset on every dimension" (grant attenuation).** The sentence can be read three ways, and they disagree on whether a child grant may equal its parent on a dimension:
  (a) the child is no wider than the parent on any dimension (equal is allowed everywhere, so an identical copy counts);
  (b) as (a), and narrower on at least one dimension (the grant as a whole is a strict subset);
  (c) narrower on every dimension. Under (c) a single-capability grant can never be attenuated (its capability set cannot shrink without becoming empty), and nor can any grant whose bounds are already `(public, operator)`.
  The build plan's test ("rejects any widening on any dimension, including expiry extension") is true under all three readings, and that part is implemented: `attenuationViolations` refuses any child that is wider on any dimension. Nothing in the code declares a grant a *valid* attenuation until the operator says which reading is meant. Slice 1 has no delegation, so nothing else in Slice 1 waits on this.

## Notes for the next session
- Docker: the session-start hook left a stale `/var/run/docker.pid` whose PID had been reused, so `dockerd` refused to start. Removing the pid file and starting `dockerd` by hand fixed it.

# JUNO — Slice 1 Build Plan

**Implements:** Core Semantic Model v0.5.1, §18
**Stack:** TypeScript on Node, strict mode, runtime schema validation at boundaries
**Runtime:** Two containers — enforcement boundary and workload sandbox
**Built by:** The operator, using an AI coding agent, in irregular bursts

---

## 0. The constraint that shapes everything

Sessions are irregular and separated by weeks. The operator does not read code. Therefore:

> **Every increment ends with a green test suite and a written state file. Verification is mechanical, never visual.**

You do not review the agent's code. You run `make verify` and read the result. If it is green and the state file says the increment is done, it is done. This is only safe because the increments are small and each one's tests assert a property from the semantic model rather than an implementation detail.

Three rules the repo enforces so that discipline survives the gaps:

1. **The repo carries its own memory.** `STATE.md` records what is done, what is next, and every decision made during a session that is not already in the semantic model.
2. **Nothing is done until `make verify` is green.** A session that ends red ends with the failure written into `STATE.md`, not with a promise.
3. **The semantic model is the specification.** The agent implements from it. Where the agent believes the model is wrong, it writes the objection into `STATE.md` and stops rather than improvising.

---

## 1. Container topology

Two containers. This is §3.4.1 made physical rather than conventional.

```
┌─────────────────────────────────────────────────────────────┐
│  juno-runner            (enforcement boundary)              │
│                                                             │
│  • admission, grants, provenance resolution, enforcement    │
│  • provider calls (holds API credentials)                   │
│  • writes the journal                                       │
│                                                             │
│  mounts:  journal-vol   (rw)   ← workload cannot see this   │
│           work-vol      (rw)                                │
│  network: provider endpoints only                           │
└─────────────────────────────────────────────────────────────┘
                            │ spawns, execFile, argv array
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  juno-workload          (task isolation tier)               │
│                                                             │
│  • runs the task's capability invocations only              │
│                                                             │
│  mounts:  work-vol      (rw)   ← the git worktree           │
│  network: NONE                                              │
│  user:    non-root, all Linux capabilities dropped          │
│  no access to journal-vol, no access to credentials         │
└─────────────────────────────────────────────────────────────┘
```

**Invariants this makes physical**

| Model requirement | Enforced by |
|---|---|
| Journal outside every task's isolation tier (§3.4.1) | `journal-vol` is not mounted into `juno-workload` |
| The executing model never holds a credential (§3.2) | Credentials exist only in `juno-runner`'s environment |
| Egress control (§2.2.1) | `juno-workload` has no network at all in slice 1 |
| Structural channel for `data` fields (§2.4) | `execFile(program, argv[])` across the container boundary; no shell exists in the workload image |

**Deliberately simple in slice 1:** no orchestrator, no compose profiles beyond one file, no image registry. Two images, one `docker-compose.yml`, one `make` target.

---

## 2. Repo layout

```
juno/
  STATE.md                  ← session memory. Read first, write last.
  DECISIONS.md              ← decisions made during build not in the model
  spec/
    core-semantic-model.md  ← v0.5.1, copied in. The specification.
  packages/
    contracts/              ← types + runtime schemas. Pure, no I/O.
    journal/                ← append-only hash-chained store
    registry/               ← capability definitions, adapters, conformance suite
    enforcement/            ← grants, provenance, the five checks
    runner/                 ← admission, turn loop, park/resume, closure
  containers/
    runner.Dockerfile
    workload.Dockerfile
    docker-compose.yml
  test/
    acceptance/             ← the five §18 tests
  Makefile
```

`packages/contracts` depends on nothing. Everything else depends on it and, where noted, on the package above it. No cycles — the dependency order *is* the build order.

---

## 3. Build increments

Seven increments, dependency-ordered. Each is independently verifiable and independently stoppable. **Do not start an increment until the previous one is green.**

### Increment 0 — Scaffold and the verification harness

*Builds the thing that tells you whether everything else works. Do this first even though it produces no product behaviour.*

- TypeScript strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Test runner with watch mode.
- Runtime schema library at every boundary (parse, don't validate).
- **Lint rule banning `child_process.exec`, `execSync`, `shell: true`, and template-literal command construction.** This is §2.4 enforced at the code level, and it is the single highest-value line in the scaffold.
- Both containers building; `docker-compose up` runs and exits cleanly.
- `make verify` runs: typecheck → lint → unit tests → container build. One command, one answer.
- `STATE.md` and `DECISIONS.md` created.

**Done when:** `make verify` is green on an empty project, and the lint rule provably fails a deliberately-added `exec()` call.

---

### Increment 1 — Contracts and the lattice

*Pure logic, no I/O, fully unit-testable. This is where the model's arithmetic gets proven correct before anything depends on it.*

Implements: §1.1–1.2, §2.1–2.3, §2.6, §3.1, §3.2, §3.5.

- Sensitivity and integrity as ordered enums.
- `join(inputs) → dataClass` — `max` sensitivity, `min` integrity.
- Task, Capability, Grant, TrajectoryEntry, Closure, Artifact as types **and** runtime schemas.
- Field role (`instruction` | `data`) with **`instruction` as the parse-time default** when the role is absent (§2.2 rule 1).
- Schema rejects complex-typed `instruction` fields (§2.2 rule 2).
- Argument provenance classes and the `${<seq>.<path>}` reference grammar (O9), with a parser.
- Grant attenuation check: is grant B a strict subset of grant A on every dimension.
- Interpreter test as a predicate over a program name plus its known flag surface (§2.3).

**Tests assert model properties, not implementation:**
- Join is commutative, associative, and monotonic in the right direction on both axes.
- Task `sensitivity_floor` cannot decrease.
- A field with no declared role parses as `instruction`.
- A `list`-typed `instruction` field fails to parse.
- Attenuation rejects any widening on any dimension, including expiry extension.
- Reference grammar rejects cross-task, ambiguous, and unresolvable forms.

**Done when:** those properties hold under test, including property-based tests for the join.

---

### Increment 2 — Journal

Implements: §3.4.1–3.4.2.

- Append-only entries, hash-chained (`hash_prev`).
- Content-addressed blob store for payloads.
- Writer lives in `juno-runner`; storage on `journal-vol`.
- Chain verification: walk the chain, detect any mutation, truncation, or reordering.
- Read interface — a plain function, **not a Capability**, with no selector able to name it (§3.4.1).

**Tests:**
- A tampered entry fails chain verification.
- A truncated chain fails verification.
- The workload container cannot read or write `journal-vol` (asserted by running a read attempt inside it and expecting failure).

---

### Increment 3 — Registry, adapters, and the conformance suite

Implements: §2.1, §2.3, §2.4, §2.5.

- Capability definitions as versioned files under source control (§2.5: operator-authored, few, reviewable).
- `shell.run(program: enum, argv: list<string>, cwd: path)` with roles declared, interpreter-free enum.
- Adapter: `execFile` across the container boundary, argv as an array.
- **Registration conformance suite** (§2.4): feed a canary containing shell metacharacters and quotes through the adapter; assert it arrives as a discrete argv element and appears in no parsed string in the outbound invocation. Failure blocks registration.

**Tests:**
- The canary survives intact through the conforming adapter.
- A deliberately non-conforming adapter (string-interpolating) is **blocked at registration** — this is §18 acceptance test 5.
- Adding `sh` to the enum fails the interpreter predicate — §18 acceptance test 4a.

---

### Increment 4 — Enforcement boundary

Implements: §2.6–2.7, §3.2.

- Grant storage and lookup; expiry and invocation-count enforcement.
- `bound` reference resolution against the task's own trajectory, recording `binding_resolution` entries with the candidate set where the shape matches more than one entry.
- Per-argument integrity computation by provenance class.
- The five enforcement checks in order, each producing the correct park reason.

**Tests:**
- A synthesized value in an `instruction` field parks `integrity_floor`.
- A bound reference into a `data` field passes with the referenced entry's integrity.
- A literal matching a prior value is still `synthesized` — no credit for coincidence (invariant 7).
- A cross-task reference is rejected.
- An expired grant fails; a revoked grant fails; an over-count grant fails.

---

### Increment 5 — Runner

Implements: §5, §6.1–6.2, §3.4.4, §7.8 (`steer_capability` derivation only — no Steer yet).

- Admission: checks 1–11, `context_ownership` and `steer_capability` derived, `criterion_integrity` recorded.
- One provider adapter, one Provider Capability Profile.
- Turn loop: assemble → call → capability invocation → journal → repeat.
- Park on `awaiting_grant`, `integrity_floor`, `budget_exceeded`, `ttl_expired`.
- Budget enforcement on all four axes.
- Verification: run the declared command; **closure written by the runner, never the model**; `verifier_identity ≠ executing actor` asserted at write time.

**Tests:**
- A task with no criterion admits as non-`verified`.
- A model-drafted criterion carries `derived` integrity and cannot produce `verified` closure.
- Budget exhaustion on each axis independently parks the task.
- Closure written with `verifier_identity` equal to the executing actor is rejected by the schema.

---

### Increment 6 — Resume

Implements: §6.3–6.4.

- Re-evaluate grants, `model_policy`, `sensitivity_floor` on resume.
- Expired or revoked grant → immediate re-park.
- `resume` entry records what changed.
- TTL covering running and parked time.

**Tests:**
- A task parked with a grant that expires while parked re-parks on resume rather than proceeding.
- TTL expiry moves the task to `failed` and releases everything.

---

### Increment 7 — Acceptance

The five §18 tests, run end to end against the real containers.

| Test | Proves |
|---|---|
| 1 — park, stop, resume next day, read the trajectory | Evidence contract (§3.4.5): "why did this happen" answerable from the journal alone |
| 2 — objective inducing a synthesized command string | The injection defence fires and is not overridable |
| 3 — objective requiring a runtime-discovered filename via `bound` reference | **Autonomy survives the defence** |
| 4a — attempt to add `sh` to the enum | Governance rejects it |
| 4b — force the enum change | Mechanism promotes the argv position to `instruction` and parks |
| 5 — register a string-interpolating adapter | Conformance suite blocks registration |

**Tests 2 and 3 are the pair that matters.** Either alone is easy: a system that refuses everything passes 2, and a system with no defence passes 3. Passing both means the boundary is in the right place.

---

## 4. Cold-session protocol

Hand the agent this at the start of every session, verbatim:

```
Read spec/core-semantic-model.md and STATE.md before doing anything.

STATE.md tells you which increment is current and what is left in it.
The semantic model is the specification — implement from it, do not
improvise. If you believe the model is wrong or ambiguous, write the
objection into STATE.md and stop; do not resolve it yourself.

Work only on the current increment. Do not start the next one.

Before you finish:
  1. Run `make verify`. It must be green.
  2. Update STATE.md: what you completed, what remains, anything you
     discovered that a future session needs.
  3. Record any decision not already in the semantic model in
     DECISIONS.md, with its reason.

If `make verify` is red when you stop, write the exact failure into
STATE.md. Do not describe it as done.
```

`STATE.md` structure:

```markdown
# STATE

## Current increment
N — <name>

## Done in this increment
- ...

## Remaining in this increment
- ...

## make verify
GREEN as of <date>   |   RED: <exact failure>

## Open objections to the spec
- ...   (these reopen design review per §0.6 standing exception)

## Notes for the next session
- ...
```

**Your job each session:** run `make verify` yourself at the end and read the result. Green means done. Red means not done, whatever the agent said.

---

## 5. Deliberately not in slice 1

From §18, restated so it does not creep back in during a session months from now:

Steer · Override · decision queue · resource locking · estate budgets · Surface contract · approval interface · supervisory console · plugins · multiple providers · multiple concurrent tasks.

One task cannot contend with itself, cannot be steered while nobody watches it, and needs no queue. These land in slice 2 alongside the console, which is what makes them meaningful.

**Also not in slice 1, per §14:** any custom context compaction, planning logic, retrieval orchestration, memory system, or tool-call parsing. Consume the provider's.

---

## 6. What slice 1 proves

Not that JUNO works. That the **enforcement boundary is in the right place** — which is the only part of the design that cannot be retrofitted.

If tests 2 and 3 both pass against real containers, then the injection defence and autonomy survive each other, the journal sits beyond the task's reach, and the five contracts hold under a real run. Everything after that is addition rather than correction.

That is also the moment §0.6's stopping rule expires: trajectory data exists, and design review earns its next turn.

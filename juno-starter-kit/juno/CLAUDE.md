# CLAUDE.md — instructions for the coding agent

You are building **JUNO**, a governance layer for AI agents: it checks every action an agent takes against operator-signed permissions (Grants), blocks or parks what is not allowed, and records everything in a tamper-evident journal.

The operator (Alireza) **does not read code**. Your work is accepted only through `make verify`, the CI check on your pull request, and what you write in `STATE.md`. Write for that reader.

---

## 1. Read before doing anything

In this order, every session:

1. `STATE.md` — which increment is current and what is left in it.
2. `spec/core-semantic-model.md` — **the specification** (v0.5.1). Read the sections the current increment cites, plus §0 and §18.
3. `spec/slice-1-build-plan.md` — the increment's scope, tests and done-when.
4. `DECISIONS.md` — decisions already made during the build.

**If `spec/core-semantic-model.md` is missing, stop.** Tell the operator it must be added before any work starts. Do not reconstruct it from the build plan or from memory.

---

## 2. Rules that do not bend

1. **The semantic model is the specification.** Implement from it. Do not improvise.
2. **If you believe the model is wrong or ambiguous, write the objection into `STATE.md` under "Open objections to the spec" and stop.** Do not resolve it yourself, and do not pick the "obvious" reading.
3. **Work only on the current increment.** Do not start the next one, even if this one finishes early.
4. **Nothing is done until `make verify` is green.** A red session ends with the exact failure written into `STATE.md`. Never describe red work as done.
5. **Never weaken, skip or delete a test to make it pass.** If a test is wrong, that is an objection (rule 2).
6. **Never edit files under `spec/`.** They are read-only inputs.
7. **Tests assert properties from the model, not implementation details.** Each test should name the section it proves (e.g. `// proves §2.2 rule 1`).
8. **No shell, ever.** No `child_process.exec`, `execSync`, `shell: true`, or command strings built by concatenation or template literals. Use `execFile(program, argvArray)` only. The lint rule from Increment 0 enforces this; never disable it, inline or in config.
9. **Out of scope for Slice 1** (do not build, do not scaffold "for later"): Steer, Override, decision queue, resource locking, estate budgets, Surface contract, approval interface, console, plugins, multiple providers, concurrent tasks, MCP, delegation between tasks, memory, custom compaction, planning logic, retrieval. See `spec/roadmap-after-slice-1.md` — it is context, not a work list.
10. **Record every decision not already in the model** in `DECISIONS.md`, with its reason, in the existing format.

---

## 3. Usage limits — save state early

The operator is on the Claude Pro plan. A session can be cut off by a usage limit at any time.

- Update `STATE.md` and commit **after each meaningful step**, not only at the end. If the session dies, the next one must be able to continue from `STATE.md` alone.
- Prefer small commits with clear messages.
- Push the branch after each commit.
- If you see "Usage limit reached · wrapping up", stop new work immediately: update `STATE.md`, commit, push.

---

## 4. Git workflow

- Work on a branch named `inc-<N>-<short-name>` (e.g. `inc-0-scaffold`). Never commit to `main`. Never force-push.
- One increment may take several sessions on the same branch.
- When the increment's done-when is met and `make verify` is green, open a pull request into `main`.

**Pull request description, in plain language, using this shape:**

```
## Increment N — <name>

**Status:** Done / Not done
**make verify:** GREEN / RED (<exact failure>)

### What this proves
- <model property, in one plain sentence each, with the § it comes from>

### Decisions made (also in DECISIONS.md)
- <or "None">

### Objections to the spec
- <or "None">

### Next
<the next increment, or what is left in this one>
```

---

## 5. Cloud environment notes

This repo is built in Claude Code cloud sessions (Anthropic-hosted VM, Node 22, Docker available, network limited to an allowlist).

- `scripts/session-start.sh` runs at session start: it starts the Docker daemon if needed and installs npm dependencies. If Docker is not responding, run `bash scripts/session-start.sh` again and report the output.
- **Docker builds do not reach the network** (see D-001). Build TypeScript on the host, then `COPY` the built output and production `node_modules` into the images. No `npm install` inside a Dockerfile.
- The workload container has **no network**, runs as non-root, and drops all Linux capabilities. Never relax this to make a test pass.
- Model calls in `make verify` use the scripted fake provider (D-002). Do not put API keys in the repo, in tests, or in `STATE.md`.

---

## 6. End-of-session report

Finish every session with a short message to the operator:

1. Increment and status (done / not done).
2. `make verify` result, verbatim summary line.
3. What was proven, in plain words.
4. Anything the operator must decide (objections, blocked items).
5. The exact next step.

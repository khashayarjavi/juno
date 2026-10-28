# DECISIONS

Decisions made during the build that are **not** in the Core Semantic Model. Each one has a reason. Add new entries at the bottom, numbered in sequence.

Format:

```
## D-NNN — <title>
- Date: YYYY-MM-DD
- Status: Accepted | Proposed | Superseded by D-NNN
- Applies to: <increment or "forward record">
- Decision: <one or two sentences>
- Reason: <why>
```

D-001 to D-007 were set during the October 2026 planning review, before the build started. The operator may revise any of them.

---

## D-001 — Docker builds do not reach the network
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: TypeScript is compiled on the host, and the built output plus production `node_modules` are copied into the images. No Dockerfile runs `npm install` or downloads anything except its base image.
- Reason: cloud sessions route traffic through a security proxy with an allowlist, so network calls inside `docker build` are fragile there. It also makes images reproducible and keeps the build consistent with the workload container's no-network invariant (§2.2.1).

## D-002 — `make verify` uses a scripted fake provider
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 5 onward
- Decision: the provider adapter is tested against a scripted fake that returns predetermined model outputs. All acceptance tests run against the fake. A real-provider smoke test may exist as `make smoke`, but it never runs in `make verify` or CI.
- Reason: tests 2 and 3 must prove the enforcement boundary regardless of what a model chooses to do, so the model's output must be controlled. It also keeps CI free, deterministic and keyless. JUNO cannot use the operator's Claude subscription (third-party harnesses are excluded since April 2026), and `api.anthropic.com` cannot receive a cloud-environment network secret, so a real key would need to sit in an environment variable.

## D-003 — Increment numbering
- Date: 2026-10-28
- Status: Accepted
- Applies to: all of Slice 1
- Decision: the build plan says "seven increments" but lists eight, numbered 0 to 7. Use the numbering as listed. Increment 7 is acceptance.
- Reason: removes an ambiguity before it reaches a session.

## D-004 — MCP protocol target (forward record)
- Date: 2026-10-28
- Status: Accepted
- Applies to: forward record — the first slice that adds MCP. Not Slice 1.
- Decision: target MCP specification revision 2026-07-28. Servers that only speak 2025-11-25 are not supported.
- Reason: 2026-07-28 removed protocol-level sessions and hardened authorization; it is not backward compatible.

## D-005 — STDIO MCP server commands are operator-authored only (forward record)
- Date: 2026-10-28
- Status: Accepted
- Applies to: forward record — the first slice that adds MCP. Not Slice 1.
- Decision: the command and arguments that launch a STDIO MCP server are registry entries written by the operator, with `instruction` role. They are never supplied, edited or selected by a model, a task, or retrieved content.
- Reason: the April 2026 MCP STDIO disclosure showed that launching a configured command is arbitrary code execution by design. Making the launch definition operator-authored puts it on the trusted side of the trust-relocation principle (few, static, operator-authored).

## D-006 — Delegation provenance test moves out of Slice 1 (forward record)
- Date: 2026-10-28
- Status: Accepted
- Applies to: forward record — the slice that introduces delegation between tasks.
- Decision: the October review proposed an "acceptance test 6": an injection read by a delegated sub-task cannot change the parent's control flow or widen its grants. Slice 1 has no delegation and no concurrent tasks, so the test is deferred to the slice that adds them, where it becomes mandatory.
- Reason: the test cannot be written without the feature. Recording it here keeps it from being lost.

## D-007 — CI runs `make verify` on every pull request
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: `.github/workflows/verify.yml` runs `make verify` on every pull request into `main`. The operator accepts an increment when the CI check is green and `STATE.md` says the increment is done.
- Reason: the build plan asks the operator to run `make verify` personally. The operator builds in cloud sessions and does not keep a local toolchain, so CI is the independent run. It also stops the coding agent from being the only witness to its own result.

## D-008 — Repository layout: the starter kit lives at the repo root
- Date: 2026-10-28
- Status: Accepted (operator, 2026-10-28)
- Applies to: Increment 0 onward
- Decision: the starter kit was first committed one level down (`juno-starter-kit/juno/`), with `juno-starter-kit.zip` beside it. Its contents now sit at the repository root, and the nested folder and the zip have been removed.
- Reason: GitHub runs workflows only from the root `.github/workflows/`, so with the kit nested, the D-007 CI check could never run. The SessionStart hook in `.claude/settings.json` also never fired. The zip duplicated tracked files.

## D-009 — Semantic model file renamed, content unchanged
- Date: 2026-10-28
- Status: Accepted (operator, 2026-10-28)
- Applies to: Increment 0 onward
- Decision: the spec arrived as `spec/core-semantic-model.md.md`. It was renamed to `spec/core-semantic-model.md` with `git mv`, and the content is byte-identical. The operator confirmed the file is the final v0.5.1. The `spec/README.md` final-version check looks for the wildcard-egress cross-reference in §8.3. That reference actually sits in §3.2 (it cites §8.3's "cannot observe the consequence" criterion), and §2.2.1 states it too. The operator accepted it there.
- Reason: CLAUDE.md §1 requires the file at exactly this path. A rename is not a content edit. CLAUDE.md rule 6 is about content.

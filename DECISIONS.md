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

## D-010 — Toolchain: TypeScript 6.0, ESLint 10 with typescript-eslint, Vitest 5
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: TypeScript 6.0.x, ESLint 10 (flat config) with typescript-eslint's `strict` preset, and Vitest 5 as the test runner (`npm run test:watch` for watch mode). Versions are pinned exactly in `package.json`. ES modules, `NodeNext` resolution, Node 22.
- Reason: TypeScript 7 is current, but typescript-eslint supports only versions below 6.1, and a lint rule that cannot parse the code is no control. Vitest runs TypeScript without a separate build step and has watch mode built in. Exact pins keep `make verify` reproducible between sessions weeks apart.

## D-011 — Runtime schema library: Zod 4
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: Zod 4 is the runtime schema library. Every boundary goes through `parseAtBoundary(boundary, schema, input)` in `packages/contracts`. It returns the typed value or throws `BoundaryError`, which callers treat as fail-closed.
- Reason: Zod gives the TypeScript type and the runtime check from one definition, so the two cannot drift. One helper means every boundary rejects input the same way (§0.2 D8).

## D-012 — The no-shell lint rule is a local plugin, and inline lint config is off
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: `tools/eslint-plugin-juno` defines `juno/no-shell`, at error level on every file. It allows only `execFile` to be imported from `child_process`, so `exec`, `execSync`, `spawn`, `fork`, `execFileSync`, whole-module imports, `require` and re-exports are all banned. It bans a `shell` option set to anything but the literal `false`. It also bans building an `execFile` program or argv element with a template literal or `+`. `noInlineConfig: true` makes every `eslint-disable` comment in the repo ineffective. `make lint` also feeds a deliberately non-conforming file to the real ESLint CLI and fails if ESLint does not reject it.
- Reason: CLAUDE.md rule 8 says use `execFile(program, argv)` only, and the rule must never be disabled inline. An allowlist fails closed, whereas a denylist misses the next launcher. Like the §2.4 conformance suite, the rule catches honest mistakes, not deliberate evasion (for example `process.binding`). That limit is stated in the rule's header (§0.5 corollary).

## D-013 — Container images and runtime settings for Slice 1
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: the runner image is `node:22-bookworm-slim` and the workload image is `gcr.io/distroless/nodejs22-debian12:nonroot`, both pinned by digest. The workload image therefore has no shell and runs as user 65532. Both services drop all Linux capabilities and set `no-new-privileges`. Both use `network_mode: none` in Increment 0. The runner gets its provider endpoints in Increment 5, and the workload never gets a network. The workload's default command is `node --version`, because it has nothing to run until capability invocations exist. `make verify` checks the images after building them (`test/containers/`): no shell file anywhere in the workload filesystem, non-root, zero capabilities, loopback only, no journal mount, and `docker compose up` exits 0 for both services.
- Reason: digest pins keep builds reproducible across sessions weeks apart (D-001). Distroless is the smallest image that removes the shell rather than relying on it going unused (build plan §1). The runner has no network in Increment 0 because nothing needs it yet (§0.2 D8, fail closed). `no-new-privileges` goes with "drops all capabilities": it stops a setuid binary from gaining privileges back. The checks inspect the running containers, because a Dockerfile that looks right proves nothing.

## D-014 — Specification errata applied (operator change)
- Date: 2026-10-28
- Status: Accepted
- Applies to: `spec/core-semantic-model.md`; matters from Increment 5 (admission checks)
- Decision: the spec first committed was the v0.5.1 draft from before the two August errata. Both were applied in place, with the text taken verbatim from the August design chat: §7.8's admission-consequence paragraph now cites §5.4 check 10 (the live-steer check), not check 11 (the autonomous zero-grants warning); §8.3 gains a note that §3.2's wildcard-egress prohibition is a sibling of the non-overridable parks; the v0.5.1 changelog records both. `spec/README.md` now names the exact marker for the final version. This is an operator change to `spec/`, not an agent edit.
- Reason: a cold session implementing admission in Increment 5 would otherwise follow a wrong cross-reference. No semantics changed.

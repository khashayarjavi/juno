# JUNO — Core Semantic Model

**Version:** 0.5.1
**Supersedes:** v0.5
**Status:** Implementation baseline. Written to be implementable by a coding agent working from this document alone.
**Reading note:** This document is the memory of the project. Build sessions are irregular; assume no session remembers the previous one. Anything not written here does not exist.

---

## 0. Frame

### 0.1 What changed from v0.4

Third external review. One blocker, one correctness gap, one incoherence, plus refinements. No structural regressions — findings are now local, which is the convergence signal. See §0.6.

| # | Change | Cause |
|---|---|---|
| 1 | **Steer delivery mechanics specified per context mode** (§7.8); `turn_control` added to the provider profile; `steer_capability` derived at admission | Review #1: §7 and §10.2 were individually correct and jointly unimplementable |
| 2 | **Resource locks key on canonicalized concrete resources with containment semantics**, not on declared scope selectors | Review #2: `/repo/src` and `/repo` did not contend, making §3.3's guarantee false in the common case |
| 3 | **`steer_routing_violation` is non-overridable**, and the general rule behind all non-overridable parks is now stated | Review #3: overridable was incoherent |
| 4 | **Surface promoted to a stub contract** (§3.6) carrying `integrity_floor` and `sensitivity_max` | Review minors: surfaces were referenced by §3.4.1 and §7.5 but modelled nowhere |
| 5 | **§10.3's cost penalty stated honestly**, with its mitigation and a segmented metric | Review #4: the safe path is *not* the cheap path for `confidential`+ work |
| 6 | **Adapter registration conformance suite** | Review minor: §2.4 was review-only where a mechanical check is cheap |
| 7 | Strategy template slot provenance; `estate_deferred` moved to a status view; test 4 split into 4a/4b | Review minors |

### 0.1.0 Changed in 0.5.1

Applied without a review cycle per §0.6. One finding qualified under the standing exception (it sits inside the injection boundary); one was a mechanical-evaluability defect.

| # | Change | Cause |
|---|---|---|
| 1 | **Role assignment must match the hazard** (§2.2.1). Egress destination fields are `data`-role, governed by scope. "URL host" removed from the `instruction` examples | §2.2 and §3.2 contradicted each other on hosts: a host declared `instruction` made host-scoped grants a dead letter |
| 2 | **Wildcard `resource_scope` prohibited for `external` capabilities** | Follows from #1: if scope is the destination control, an unbounded scope is no control |
| 3 | **Admission check 10 tied to derivable fields** — `attendance` and an explicit `requires_live_steer` input | The condition "operator expects live supervision" was not mechanically evaluable |

### 0.1.1 Retained from v0.3 → v0.4

Trust-relocation principle (§0.5); adapter structural-channel contract (§2.4); fail-closed field roles and scalar-only instruction fields (§2.2); interpreter test (§2.3); keystroke-only clean compose (§7.5); sensitivity as a routing constraint (§10.3); contention as a runtime sub-state (§3.3); journal read interface (§3.4.1); steer sensitivity propagation (§7.7).

### 0.2 Operator decisions this model is built against

| # | Decision | Consequence |
|---|---|---|
| D1 | Run and govern the operator's own systems, and unify the operator's chat/agent/tool estate | Two workloads, one substrate. No workload-specific primitives |
| D2 | Gated and unattended execution equally weighted | `Grant` is durable and pre-issuable; attendance is a Task field, never a product mode |
| D3 | Inference posture configurable per use | Routing is policy evaluated against data class |
| D4 | Eventually a hosted product with subscriptions, alongside an open-source core | Principal explicit from day one; policy is data; no host assumptions. Multi-tenancy deferred |
| D5 | Content-creation model is a peer capability, later a plugin | Plugin contract is v1. Plugin *distribution* is not |
| D6 | Breadth-vs-blast-radius varies by data class | Data class is the join key across seven subsystems |
| D7 | Steer default at next safe checkpoint; immediate injection available | Both a checkpoint model and an injection model required |
| D8 | When unsure, stop and ask | Fail-closed. Parking is the universal primitive. No silent guessing |
| D9 | Fewer than 5 interruptions per day | Approvals are a **daily budget across all tasks** |
| D10 | Balanced horizon — useful soon, don't foreclose later | Own the five contracts and the lattice; keep everything else thin and borrowed |
| D11 | DPBDS is a plugin, never built into the core | Strategy is the plugin extension point |
| D12 | Built by the operator using an AI coding agent, in irregular bursts | Design artifacts self-sufficient; every slice independently shippable |

### 0.3 Invariant chain

Any proposed change violating one of these is rejected without further argument.

1. **A model may propose; it may not authorize.**
2. **Authority is scoped, issued, attenuable, and revocable** — never ambient, never inherited.
3. **Completion is established by evidence**, never by the actor that performed the work.
4. **Anything that entered as content remains untrusted**, however it arrives — including memory, tool output, retrieved files, and JUNO's own peer systems.
5. **An authorized action is not a safe action.** Authorization governs the operation; integrity governs the instruction fields; scope governs the data reach.
6. **The record is the protection.** Approval is a signal; evidence is the safeguard.
7. **Provenance is established by mechanism, never by inspection.**

Disclosed to the user at first run. See §16.

### 0.4 The evidence reweighting — rationale and references

Two findings together invert the safety design:

- **Automation bias is robust and replicated.** Humans over-accept plausible automated output.
  - Parasuraman & Manzey, "Complacency and Bias in Human Use of Automation: An Attentional Integration," *Human Factors* 52(3):381–410, 2010.
  - Goddard, Roudsari & Wyatt, "Automation bias: a systematic review of frequency, effect mediators, and mitigators," *JAMIA* 19(1):121–127, 2012.
  - Mosier et al., "Automation Bias, Accountability, and Verification Behaviors," 1996 — accountability framing increases verification.

- **Decision fatigue is contested and may not exist.**
  - Hagger et al., multi-lab pre-registered replication of ego depletion, *Perspectives on Psychological Science* 11(4):546–573, 2016 — 23 labs, N=2,141, *d* = 0.04, 95% CI [−0.07, 0.15].
  - Danziger et al. 2011 (parole rulings) challenged as a case-scheduling artifact by Weinshall-Margel & Shapard (2011) and Glöckner (2016).
  - *Communications Psychology*, 2025 — healthcare field data, no credible evidence for decision fatigue.
  - McCarley et al., "Psychometric Curves Reveal Three Mechanisms of Vigilance Decrement," *Psychological Science*, 2021 — criterion shift and lapses, not sensitivity loss.

- **Volume dependence is real where it exists.** Ancker et al., *BMC Medical Informatics and Decision Making*, 2017 — reminder acceptance drops ~30% per additional reminder per encounter.

- **Interface design dominates volume.** Akhawe & Felt, "Alice in Warningland," USENIX Security 2013 — click-through ranged from ~10% (Firefox malware) to 70.2% (Chrome SSL) on presentation alone.

- **Operator self-assessment inverts reality.**
  - Perry et al., "Do Users Write More Insecure Code with AI Assistants?", ACM CCS 2023, n=47 — less secure code, higher confidence in its security.
  - Becker et al. (METR), "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity," 2025-07-10 — 16 developers, 246 tasks: 19% slower, believed 20% faster. METR's 2026-02-24 follow-up widened to −18% [−38%, +9%] and downgraded it to weak evidence.

**Consequence.** Reducing approval count does not fix over-trust. A single approval, presented persuasively, is as susceptible as the twelfth. The durable protection is a complete, replayable record permitting after-the-fact discovery. **The approval cap in D9 stands as operator preference, not as a safety control** — no literature supports any specific number.

### 0.5 The trust-relocation principle

*New in 0.4. Two independent reviews converged on the same observation: each defence relocated trust rather than eliminating it. That will remain true of every future round, because trust cannot be removed from a system that acts in the world — only moved. The design criterion is therefore where it lands.*

> **Trust is acceptable where it rests on things that are few, static, and operator-authored.**
> **Trust is unacceptable where it rests on things that are many, dynamic, or model-influenced.**

| Acceptable trust roots | Unacceptable trust roots |
|---|---|
| Source registrations (§1.4) | Model output |
| Capability definitions and field roles (§2.5) | Retrieved content |
| Adapter contracts (§2.4) | Tool output |
| `program` enum membership (§2.3) | Runtime composition |
| Policy documents | Anything assembled per-turn |

Every accepted finding in both review rounds is an instance of trust having landed on the wrong side of this line. Every fix moves it back. **When evaluating a proposed change, ask which column its trust root sits in.** If the left, the residual risk is reviewability — few items, authored deliberately, versioned, inspectable. If the right, the design is wrong regardless of how careful the implementation is.

**Corollary — accepted residuals are stated, never hidden.** Where a control has a boundary beyond which it cannot reach (§7.5, §2.3, §3.4.3), the boundary is written down. An unexamined gap is a defect; a documented limit is a design decision.

### 0.6 Review convergence — a stopping rule

Three review rounds have now run. Round 1 found three implementation blockers, all structural. Round 2 found two, both structural. Round 3 found one blocker and two correctness gaps, all local — no finding required changing a contract, an invariant, or a state transition.

**That trajectory is the signal to stop reviewing and start building.** Each further round will find smaller things at undiminished cost, and the failure mode of this programme has never been shipping something wrong — it has been not shipping. Design review resumes when the first slice produces evidence (§18), because trajectory data answers questions no reviewer can.

**Standing exception:** any finding that touches the invariant chain (§0.3), the five contracts, or the injection boundary (§2) reopens review immediately regardless of phase.

---

## 1. Data class — the join key

### 1.1 The lattice

`data_class = (sensitivity, integrity)`

**Sensitivity** — who may ever see this:
```
public < internal < confidential < secret
```

**Integrity** — how far this may influence action:

| Level | Meaning | Typical source |
|---|---|---|
| `operator` | Authored directly by the principal | Keystroke-originated text in a clean surface |
| `attested` | Produced by a verified process under known policy | Build output, test result, signed artifact |
| `derived` | Produced by JUNO from mixed inputs | Model output, summary, plan |
| `untrusted` | Arrived as content from outside the trust boundary | File contents, web pages, tool output, peer-system output, MCP responses |

### 1.2 Join rule and contamination semantics

```
sensitivity = max(inputs)
integrity   = min(inputs)
```

**Integrity is a property of values and trajectory entries. It is not a property of tasks.**

| Object | Carries | Semantics |
|---|---|---|
| Value / trajectory entry | `(sensitivity, integrity)` | Computed at creation from its own inputs |
| **Task** | `sensitivity_floor` **only** | Monotonic non-decreasing. Exposure is cumulative; influence is not |
| Composing surface (chat session) | `integrity_floor` | Monotonic non-increasing within a session. See §7.5 |

Reading untrusted content raises a task's `sensitivity_floor` permanently and affects nothing else. Whether a given capability argument may carry instruction weight is decided per-argument by §2.6, not by task history.

### 1.3 Assignment authority

Classification is assigned **deterministically by source**, declared at registration. Every connector, mount point, repository, path prefix, and capability provider declares its class when registered.

A model may emit a `classification_proposal` into the trajectory. It may never assign a class.

### 1.4 Source registration — trust root, with contradiction detection

| Declared | Contradicted by observing | Response |
|---|---|---|
| `read-only` | Any write side-effect | Quarantine source; park all tasks holding grants on it |
| `attested` integrity | Output matching no known build, test, or signed artifact | Demote to `derived`; record `classification_contradiction` |
| `local` / no-egress | Any outbound network call from its process | Quarantine immediately — routing-policy violation |
| Sensitivity ceiling | Content exceeding ceiling by classifier heuristic | Raise a proposal; do not auto-demote |

Contradictions are recorded as artifacts and enter the metric set (§13.2). Detection is best-effort and **not** a guarantee: a lying registration remains a real failure mode. Per §0.5 the mitigation is reviewability — registrations are few, operator-authored, and versioned.

### 1.5 Unclassified

A distinct marker, not a default. It means a source was registered without a declared class — a configuration defect.

**Handling:** treat as `(secret, untrusted)`; reject at admission where detectable, park where discovered mid-run. Never guess, never degrade gracefully.

---

## 2. Capability, arguments, and the injection boundary

*This is the load-bearing section. Read it before implementing anything else.*

### 2.1 Capability

| Field | Type | Notes |
|---|---|---|
| `id` | semantic id | e.g. `fs.file.read`, `vcs.branch.create` |
| `interface` | typed schema | Every field carries a `role` — §2.2 |
| `providers` | list | Adapter bindings, each subject to §2.4 |
| `side_effect` | `read` \| `write` \| `external` \| `irreversible` | |
| `isolation_tier` | 1–5 | Minimum sandbox tier |
| `max_input_sensitivity` | sensitivity | Highest-sensitivity material this capability may receive |
| `min_argument_integrity` | integrity | **Applies to `instruction` fields only** |
| `output_class` | rule | Usually `(input.sensitivity, untrusted)` |
| `cost_model` | structured | Expected cost, latency, cost of failure |

**Invariant:** capability identity is stable across provider substitution. Swapping an MCP server for a native implementation must not change `id`, `interface`, or any grant referencing it.

### 2.2 Field roles

Every interface field is `instruction` or `data`.

| Role | Definition | Governed by |
|---|---|---|
| `instruction` | A field whose value can alter **what the capability does** — a command string, a program name, a query statement, a script body, a request route or template where structure alters behaviour, a regex driving control flow | `min_argument_integrity` |
| `data` | A field consumed as an operand — an argv element, a text payload, a numeric parameter, a path | `resource_scope` on the Grant, and `max_input_sensitivity` |

**Integrity governs instruction. Scope governs data reach.** Different controls, different hazards, never conflated.

Two schema rules, both fail-closed:

1. **A field is `instruction` unless explicitly declared `data`.** A mis-declared role is unobservable at runtime, so the default must be the safe one. Omission is not permission.
2. **`instruction` fields must be scalars.** Complex-typed instruction fields — lists, maps, nested structures — are prohibited, because whole-field `min()` over heterogeneous origins is ambiguous and per-element provenance would have to be invented. Where an operation seems to need one, it needs a different capability decomposition.

Illustration:

```
shell.exec(command: string)
  └─ command : instruction    → floor: operator
                                 entire field is instruction; no safe data path

shell.run(program: enum, argv: list<string>, cwd: path)
  ├─ program : instruction    → floor: attested  (scalar, enum-constrained)
  ├─ argv[]  : data           → floor: untrusted permitted
  └─ cwd     : data           → floor: untrusted permitted
```

A filename discovered by search and passed as `argv[1]` through `execve` **cannot become a command** — there is no shell to interpret it. The same filename interpolated into a command string can. The hazard was never the discovered data; it was the unparsed interface.

**The raw shell is a deliberate residual hazard.** Retained for cases typed capabilities do not cover, carrying an `operator` floor. Every invocation signals a missing typed capability; its count is tracked (§13.2) and should trend toward zero.

### 2.2.1 Role assignment must match the hazard

Role is not a description of a field's contents. **Role selects which control governs it** — integrity for `instruction`, scope for `data` — and the two controls answer different questions:

| Control | Question it answers | Strong when |
|---|---|---|
| Integrity (`instruction`) | *Was this value authored by someone entitled to direct behaviour?* | The hazard is **what** the capability does, and the safe set is unbounded |
| Scope (`data`) | *Is this value inside the enumerated permitted set?* | The hazard is **where** the capability reaches, and the safe set is enumerable |

**A capability author must assign the role that matches the hazard.** Assigning the wrong one does not merely weaken a control — it disables the other one entirely, silently.

**Worked example: egress destinations.** A field naming where a request goes — host, endpoint, recipient — is **`data`-role**. The hazard is *where*, not *what*, and the permitted set is enumerable, so `resource_scope` is the correct and stronger control: it can allowlist three hosts, which no integrity level can express.

Declaring such a field `instruction` would make every host-scoped grant a dead letter for that capability, moving destination control entirely to integrity — a weaker question about a hazard it does not fit. Conversely, a field carrying a request *route or template* whose structure changes what the endpoint does is `instruction`-role, because there the hazard genuinely is *what*.

```
net.http.post(host: string, path_template: string, body: string)
  ├─ host          : data        → governed by resource_scope (enumerated allowlist)
  ├─ path_template : instruction → floor: operator (structure alters behaviour)
  └─ body          : data        → governed by max_input_sensitivity
```

**Consequent rule, in §3.2 and §5.3:** a wildcard or unbounded `resource_scope` is **prohibited** for capabilities with `side_effect = external`. If scope is the destination control, an unbounded scope is no control at all, and exfiltration to an arbitrary host becomes reachable from untrusted input. Egress grants enumerate their destinations or they are not issued.

### 2.3 The interpreter rule

`shell.run(program: enum, …)` defends only if the enum excludes interpreters. `sh -c` reinstates the shell through the typed front door, and the invocation looks entirely ordinary.

> **A program is an interpreter if any argv position can cause execution of code not named by `program`.**

The test is primary; the list is illustrative and necessarily incomplete:

`sh`, `bash`, `zsh`, `fish` (`-c`) · `python`, `node`, `ruby`, `perl`, `php` (`-c`, `-e`) · `find` (`-exec`) · `xargs` · `awk` · `sed` (`e` flag) · `env` · `make` · `ssh` · `sudo` · `docker run` · `kubectl exec` · `npm`/`yarn`/`pnpm run` · `tar` (`--use-compress-program`) · `rsync` (`-e`) · **`git`** — which has `-c`, aliases, and hooks, and is an interpreter despite looking like a tool.

**Rules:**
1. Interpreters are excluded from `program` enums by default.
2. Where an interpreter is unavoidable, the **code-bearing argv positions are promoted to `instruction` role**, restoring the operator floor exactly where it belongs.
3. Enum membership is reviewed at capability registration (§2.5).
4. Interpreter-program invocations are tracked alongside raw-shell count (§13.2).

### 2.4 Adapter contract — the structural-channel requirement

`role: data` is a claim about the adapter. Without constraining adapter behaviour, the entire injection defence is a convention rather than a control.

> **A capability adapter must deliver every `data`-role field to its provider through a structural channel** — an argv array element, a prepared-statement bind parameter, a discrete typed field in a serialized request body, a distinct API parameter.
>
> **An adapter that interpolates, formats, concatenates, or templates a `data` value into any string the provider will parse forfeits its registration.**

| Permitted | Forfeits registration |
|---|---|
| `execve(prog, [arg0, arg1, …])` | `system("prog " + arg)` |
| Prepared statement with bind parameters | Query string assembly |
| JSON body field | URL path or query templating with a data value |
| Discrete header value | Header string construction |

This is the parameterized-query discipline, stated as a registration condition rather than a coding convention. An adapter that string-concatenates a `data` field recreates the raw shell behind a facade that *advertises safety* — worse than the shell, because the interface lies.

**Registration conformance suite.** Human review is the primary control, but a mechanical check is cheap and belongs in §0.5's left column. At registration, each adapter is fed a canary `data` value containing shell metacharacters, quote characters, and a structural delimiter appropriate to the provider. The suite asserts the canary arrives **structurally intact** — as a discrete argv element, bind parameter, or typed body field — and that no parsed string in the outbound request contains it. Failure blocks registration.

This does not catch a deliberately evasive adapter. It catches honest mistakes, which are the overwhelming majority.

### 2.5 Capability registry authorship

Capability definitions now carry field roles, floors, enum membership, and adapter bindings. They are a trust root, and a mis-declared role is harder to observe than a read-only connector writing — §1.4's contradiction detection does not transfer.

Per §0.5, the mitigation is placement rather than detection:

- Capability definitions are **operator-authored**, never model-generated and never auto-derived from a provider's schema.
- They are **few** — a working v1 needs perhaps a dozen.
- They are **versioned artifacts** with change history; a role or floor change is a reviewable diff.
- Plugin-supplied capability definitions require explicit operator admission before first use, presented as a diff against nothing.
- Where detection is possible it is applied: an adapter observed constructing a parsed string from a `data` field forfeits registration (§2.4) and quarantines its capability.

### 2.6 Argument provenance

| Class | Definition | Integrity |
|---|---|---|
| `constant` | Literal fixed at admission — in the objective, criterion, or a Strategy template slot **filled by the runtime**. A template slot the model fills is `synthesized`, not `constant` | Integrity of the admitting source (normally `operator`) |
| `bound` | A **reference expression** emitted by the model and resolved by the runtime from a prior trajectory entry **of the same task**. The value never round-trips through the model | Integrity of the referenced entry |
| `synthesized` | The model composed the value as free text | Under `owned` context: `min()` over the volatile region. Under `native` context: **`untrusted`, unconditionally** — see below |

**Invariant 7 — provenance is established by mechanism, never by inspection.** A model emitting a literal that happens to equal a prior value produces a `synthesized` argument. No comparison is performed; only the reference mechanism confers `bound`.

**Synthesized integrity under `native` context ownership.** When the provider owns the context, JUNO cannot enumerate the volatile region and therefore cannot compute `min()` over it. The rule is stated rather than computed: **synthesized values are `untrusted`.** This is never load-bearing, because `native` ownership is only assigned to tasks that use no synthesized instruction fields (§10.2), and `data` fields tolerate `untrusted`. Stated explicitly so that an implementer computes nothing rather than computing something wrong.

**Cross-task references are prohibited.** A `bound` reference resolves only within its own task's trajectory. Cross-task data movement goes through Artifacts, which carry their own provenance.

### 2.7 Enforcement

At each capability call, the enforcement boundary:

1. Resolves all `bound` references, recording resolution in the trajectory. Where the reference shape matches more than one entry, the **candidate set is recorded** — binding cannot forge integrity, but a hostile prior entry can be selected over a benign one, and post-hoc review must be able to distinguish misdirection from coincidence.
2. Computes integrity per argument by class (§2.6).
3. Rejects if any `instruction` field falls below `min_argument_integrity` → park `integrity_floor`.
4. Rejects if any `data` field falls outside the Grant's `resource_scope` → park `scope_violation`.
5. Rejects if aggregate input sensitivity exceeds `max_input_sensitivity` → park `sensitivity_ceiling`.
6. Rejects if the serving adapter is quarantined under §2.4 → park `adapter_quarantined`.

---

## 3. The five contracts

### 3.1 Task

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `principal` | ref | Explicit even with one user |
| `objective` | text | Verbatim |
| `criterion` | structured \| null | Machine-evaluable statement of done. Authorship: §5.2 |
| `criterion_integrity` | integrity | Integrity of the criterion's author |
| `verification` | ref \| null | Method establishing the criterion |
| `closure_mode` | `verified` \| `attested` \| `accepted` | §3.4.4 |
| `attendance` | `gated` \| `autonomous` | Per-task. Never a product mode |
| `strategy` | ref | §4 |
| `sensitivity_floor` | sensitivity | **Monotonic non-decreasing.** No task-level integrity |
| `context_ownership` | `native` \| `owned` | Derived, not chosen. §10.2 |
| `model_policy` | structured | Permitted providers; posture; **`conversation_state` constraint** (§10.3) |
| `budget` | structured | tokens, currency, wall-clock, turns |
| `ttl` | duration | Absolute lifetime including parked time. §6.4 |
| `grants` | list of ref | |
| `parent` | ref \| null | |
| `state` | enum | §6 |
| `runtime_substate` | `active` \| `blocked` \| null | §3.3 |
| `steer_capability` | `full` \| `checkpoint_only` \| `none` | **Derived at admission** from the provider profile. §7.8 |
| `requires_live_steer` | bool | Admission input. Defaults `true` when `attendance = gated`, `false` otherwise. Overridable in either direction at admission |
| `trajectory` | ref | |

**Invariants**
- `sensitivity_floor` monotonic non-decreasing.
- A Task holds no authority beyond the union of its grants, never more than its parent's.
- **Budgets attenuate to children.** A child's budget on every axis is drawn from and bounded by the parent's remaining budget; spend is attributed to the child and charged to the parent chain.
- An autonomous Task with zero pre-issued grants is admissible; it will park at its first capability call. Correct behaviour.

### 3.2 Grant

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `principal` | ref | |
| `capability_selector` | selector | One capability or a bounded set |
| `resource_scope` | selector | Paths, repos, hosts, records. **Governs `data` fields** |
| `data_class_bounds` | pair | Max sensitivity, min integrity permitted |
| `issuance` | `interactive` \| `preissued` | *When* created, not *what* permitted |
| `issued_by` / `issued_at` | ref / ts | |
| `expires_at` | ts | **Mandatory.** No perpetual grants |
| `max_invocations` | int \| null | |
| `attenuation_parent` | ref \| null | Delegation chain |
| `revoked_at` | ts \| null | |

**Invariants**
- **Attenuation only.** A derived grant is a strict subset of its parent on every dimension.
- **Effective authority = intersection** of the task's grants, the principal's baseline, and any parent's authority.
- **Re-authorization on resume.**
- **The executing model never holds a credential.** A grant references a credential held at the enforcement boundary; the task requests an effect, the boundary performs it.
- **No selector may name journal storage** (§3.4.1). Structurally impossible rather than procedurally forbidden.
- **No wildcard or unbounded `resource_scope` for `side_effect = external`** (§2.2.1). Egress destinations are enumerated or the grant is not issued. Not overridable — an unbounded egress scope makes exfiltration from untrusted input reachable, and the operator cannot observe which destination a given call will choose (§8.3).
- **Breadth is tracked** (§13.2).

### 3.3 Resource contention

Two tasks holding overlapping `resource_scope` on a `write` or `irreversible` capability must not execute concurrently against that scope.

**Contention is routine, not exceptional, and must never cost an interruption.**

**Locks key on resolved concrete resources, never on declared scope selectors.** Grants scoped `/repo/src` and `/repo` do not share a selector, but they reach the same files. Keying on selectors would make this section's guarantee false for every pair of non-identical overlapping scopes — which is the common case.

- At each invocation, the enforcement boundary **canonicalizes** the concrete resources the call will touch: absolute normalized paths with symlinks resolved, repository identifiers, `host:port` pairs, record identifiers.
- The advisory lock is held on those canonical resources for `write` and `irreversible` side-effect classes. `read` does not lock.
- **Contention is containment, not equality.** For hierarchical resources (paths, repo subtrees) two locks contend if either canonical prefix contains the other. For non-hierarchical resources (hosts, record IDs) contention is exact match.
- Resources that cannot be resolved to a canonical form before invocation are treated as contending with everything in their capability class — fail-closed.
- A task that cannot acquire enters **`runtime_substate: blocked`** — a sub-state of `running`, not a park. No queue item, no notification, no operator action.
- Blocked tasks re-attempt acquisition automatically on lock release, with bounded exponential backoff and jitter.
- Locks release on completion, park, abort, or TTL expiry.
- **Park only on** deadlock detection (a cycle in the wait-for graph) → `resource_deadlock`, or when blocked time threatens the task's `ttl` → `resource_starved`. Both are genuine exceptions and both warrant an operator decision.

### 3.4 Evidence

**The primary safety mechanism.**

#### 3.4.1 Journal location and access

> **The trajectory journal is written by the enforcement boundary, outside every task's isolation tier, in a storage namespace that no capability selector can address.**

Structural, not procedural: journal storage lives outside the capability namespace entirely, so no `resource_scope` can name it and any attempt to construct one is rejected at grant creation. A task holding shell access inside a worktree is structurally unable to truncate or rewrite its own history.

**But the supervisory console must read trajectories** — that is the entire product. v0.3 made this contradictory. Resolution:

> **The journal is exposed through a dedicated read interface that is not a Capability and cannot appear in any Grant.**

The console reads through it. Task-held authority can never name it. Read authority over the journal is a property of the **principal and the Surface** (§3.6, `journal_read`), not of any running task — so a task can never read its siblings' trajectories, and the console can read everything.

#### 3.4.2 Trajectory entry

Append-only, hash-chained, readable while the task runs.

| Field | Notes |
|---|---|
| `seq` | Monotonic within task |
| `task_id` | |
| `kind` | `turn` \| `capability_call` \| `capability_result` \| `binding_resolution` \| `steer` \| `park` \| `resume` \| `block` \| `unblock` \| `override` \| `gate` \| `note` \| `abandon` \| `classification_proposal` \| `classification_contradiction` |
| `actor` | Which model or component produced this |
| `provider` | Which provider served it |
| `payload_ref` | Content-addressed; large payloads in blob store |
| `data_class` | `(sensitivity, integrity)` of this entry's content |
| `argument_provenance` | On `capability_call`: per-argument class and computed integrity |
| `binding_candidates` | On `binding_resolution`: the candidate set where the reference shape matched more than one entry |
| `cost` | tokens in / out / cached, currency, duration |
| `hash_prev` | Chain link |
| `timestamp` | |

#### 3.4.3 Replayability — a graded property

Captured during execution; none reconstructable afterward: model identifier **and version string**; sampling settings; exact prompt content hash per turn *(conditional)*; tool/adapter versions; environment digest; external state references with timestamps; wall-clock timestamps.

Prompt hashing is impossible where the provider holds conversation state and never returns the assembled context. Rather than silently violating the requirement:

| `replay_fidelity` | Condition |
|---|---|
| `full` | Complete assembled context hashed per turn; all settings captured |
| `partial` | Server-held state; inputs and outputs captured, assembled context not |
| `none` | Provider returns neither context nor stable version identifiers |

A field on the Provider Capability Profile (§13.1), **recorded in closure**, and **a routing input**.

**Accepted residual:** provider-side updates, external state drift, and non-deterministic sampling mean replay produces a *comparable* run, not an identical one. A divergent replay is data, not a failure.

#### 3.4.4 Closure

| Field | Notes |
|---|---|
| `task_id` | |
| `criterion_ref` | The criterion **as admitted** |
| `criterion_integrity` | Carried forward |
| `verification_method` | |
| `verification_result` | pass / fail / inconclusive |
| `closure_mode` | `verified` \| `attested` \| `accepted` |
| `verifier_identity` | **Must not equal the executing actor** |
| `replay_fidelity` | From the serving provider |
| `artifacts` | list of ref |
| `cost_actual` | tokens, currency, wall-clock, turns |

| Mode | Basis | Strength |
|---|---|---|
| `verified` | Deterministic method passes against an `operator`-integrity criterion | Strong |
| `attested` | A second, differently-configured actor asserts completion | **Weak — recorded as weak** |
| `accepted` | The operator closes it | Weakest — records a human judgment, not a fact |

**`verified` additionally requires `criterion_integrity = operator`.** A model-drafted criterion the operator merely glanced at cannot license the strongest closure.

*Status flag: RB-2 (verification beyond code) not run. Reasoned position, not validated.*

#### 3.4.5 Retention and audit

Retention indexed by `sensitivity`. Deletion obligations attach to sensitivity. Derived stores are rebuildable from the journal; the journal is not derived.

**Acceptance test:** *"Why did this happen?"* must be answerable from the journal alone.

### 3.5 Artifact

| Field | Notes |
|---|---|
| `hash` | Content address; identity |
| `type` | |
| `producing_task` | ref |
| `data_class` | |
| `inputs` | Provenance |
| `supersedes` | ref \| null. A revision is a new artifact, never a mutation |

Artifacts are the **only** cross-task data channel (§2.6).

### 3.6 Surface — stub contract

Referenced by §3.4.1 (journal read authority) and §7.5 (composing-surface integrity), so it is modelled here rather than left implicit. **This is a stub pending the supervisory-console design; only the fields other sections depend on are specified.**

| Field | Notes |
|---|---|
| `id` | |
| `principal` | Whose surface this is |
| `kind` | `chat_session` \| `clean_compose` \| `console` \| `terminal` |
| `integrity_floor` | Initialised `operator`. **Monotonic non-increasing** within the surface's life (§7.5) |
| `sensitivity_max` | Initialised `public`. **Monotonic non-decreasing.** Highest sensitivity read into this surface |
| `journal_read` | Whether this surface may read trajectories through the §3.4.1 interface |

A steer's `integrity` is the composing surface's `integrity_floor`; its `sensitivity` is the surface's `sensitivity_max` joined with its own payload. Both are surface properties, not task properties, and both reset only by starting a new surface.

---

## 4. Strategy and the plugin contract

### 4.1 Strategy

A field on Task, not a mode of JUNO. It declares: decomposition into plan steps; the plan artifact and its durability; gates before execution and between steps; what constitutes a **safe checkpoint** (§7.2); what constitutes a valid criterion.

Built-in: `direct`, `plan-then-execute`, `explore` (read-only reconnaissance producing a plan artifact and nothing else).

### 4.2 The plugin contract — v1

**Strategy is the plugin extension point.**

> **A plugin may add gates. A plugin may never grant authority.**

A plugin can park a task. It can never unpark one, never issue a Grant, never satisfy another plugin's gate, never authorize an effect. Plugin-supplied capability definitions require explicit operator admission (§2.5).

JUNO's enforcement governs *effects on the machine and the estate*; a governance plugin such as DPBDS governs *the epistemic quality of its own artifacts*. Different object domains, one parking mechanism.

**In v1:** registration, gate hooks, checkpoint definition, artifact types.
**Not in v1:** third-party distribution, signing, sandboxing untrusted plugins, marketplace.

---

## 5. Admission

### 5.1 Admission produces three things

| Output | If absent |
|---|---|
| Objective | **Reject** |
| Criterion | Admit with `closure_mode` ≠ `verified` |
| Verification method | Admit with `closure_mode` ≠ `verified` |

Fidelity is unverifiable unless the instruction was converted into something checkable **before** execution.

### 5.2 Criterion authorship

- Operator-written criterion → `operator` integrity.
- **Model-drafted criterion → `derived` integrity**, visually distinguished at admission as model-authored.
- Explicit operator acceptance promotes it to `operator`. Acceptance is a distinct act, never a side effect of starting the task.
- **The acceptance surface restates the criterion's checkable consequences, not its text.** Accepting a model-drafted criterion is itself acceptance of plausible generated output — the automation-bias situation. Showing "this will be considered done when `pytest tests/` exits 0 and `git diff --stat` shows changes only under `src/`" is reviewable; showing the criterion's prose is not.
- Only `operator`-integrity criteria license `verified` closure.

Without this, a model can propose the standard against which its own work is judged — an injection path into the admission boundary, upstream of every other protection.

### 5.3 Admission concentrates decisions — and its risk

Under D9 admission is where decisions must happen: the operator is already engaged, so deciding there is free; deciding mid-run costs a full interruption against five per day.

**Counter-risk, stated rather than hidden:** concentrating decisions at admission means granting authority with the least information about how it will be used. The failure mode is blanket pre-issued grants.

Admission-time exposure differs from mid-run exposure rather than exceeding it: at admission there is no partial artifact, no sunk cost, no persuasive rationale, no time pressure — and the automation-bias literature concerns acceptance of *plausible generated output*, which is the mid-run situation. The concentration stands; the controls against blanket grants are tightened:

- `expires_at` mandatory, defaulting to the task's `ttl`.
- `max_invocations` required for `write`, `external`, `irreversible`.
- `resource_scope` narrower than the whole machine; a whole-filesystem scope requires an explicit Override (§8).
- **Egress scopes enumerated.** No wildcard `resource_scope` on `external` capabilities, and no Override available for it (§3.2).
- **Grant breadth is tracked** (§13.2).

### 5.4 Admission checks

1. Objective present.
2. Criterion and verification present, or `closure_mode` set accordingly.
3. `criterion_integrity` recorded.
4. All referenced sources carry a declared data class. Any `unclassified` → reject.
5. `model_policy` satisfiable against at least one registered provider given the task's sensitivity **and its `conversation_state` constraint** (§10.3). If not → reject.
6. Budget declared on all four axes; within remaining estate budget (§9).
7. `ttl` declared.
8. `context_ownership` derived (§10.2). **If `native` and no permitted provider offers native context management, reject** — never silently degrade to `owned` with the cost profile of `native`.
9. All capabilities in scope have registered, non-quarantined adapters passing the §2.4 conformance suite.
10. `steer_capability` derived (§7.8). **If `requires_live_steer = true` and no permitted provider offers `steer_capability: full`, reject** — never admit a task whose steers will silently fail to land. `requires_live_steer` defaults from `attendance` and is an explicit admission input, so this check is mechanically evaluable from task fields alone.
11. If `autonomous`: warn when zero grants are pre-issued.

---

## 6. Task state machine

```
draft ──admit──> admitted ──start──> running ⇄ (runtime_substate: blocked)
                                       │
        ┌──────────────┬───────────────┼────────────────┬──────────┐
        │              │               │                │          │
     parked      complete_        verified           failed     aborted
   (reason)      unverified
        │              │
        │ resume       ├── operator triggers verification ──> verified | failed
        │ (re-auth)    └── operator closes without check ───> accepted
        └──> running
```

`running` also accepts `steer` and `override` transitions without changing state. `blocked` is a runtime sub-state of `running`, not a park (§3.3).

### 6.1 Verification is triggered, never conferred

The operator may **trigger** or **repair** verification. The operator may never **confer** `verified`. Closing without a passing deterministic check yields `accepted`.

### 6.2 Park reasons

| Reason | Trigger | Overridable? |
|---|---|---|
| `awaiting_grant` | Capability call with no covering grant, no human present | Yes |
| `awaiting_classification` | `unclassified` source encountered mid-run | Yes |
| `routing_unavailable` | Required posture or `conversation_state` cannot be served | Yes |
| `integrity_floor` | `instruction` field below `min_argument_integrity` | **NO — §8.3** |
| `scope_violation` | `data` field outside grant `resource_scope` | Yes |
| `sensitivity_ceiling` | Input sensitivity above capability ceiling | Yes |
| `adapter_quarantined` | Serving adapter forfeited registration (§2.4) | **NO** |
| `resource_deadlock` | Cycle in the wait-for graph (§3.3) | Yes |
| `resource_starved` | Blocked time threatens `ttl` (§3.3) | Yes |
| `budget_exceeded` | Any task budget axis | Yes |
| `estate_budget_exceeded` | Daily estate ceiling (§9) | Yes |
| `gate_unmet` | Strategy or plugin gate failed | Yes |
| `steer_conflict` | Applied steer contradicts the admitted criterion | Yes |
| `steer_routing_violation` | Steer would raise `sensitivity_floor` past the serving provider (§7.7) | **NO — §8.3** |
| `steer_undeliverable` | A pending steer cannot reach the task under its context mode (§7.8) | Yes |

### 6.3 Resume

1. Re-evaluate all grants; expired or revoked → re-park.
2. Re-evaluate `model_policy` against current provider availability.
3. Re-evaluate `sensitivity_floor` against routing policy.
4. Re-acquire resource locks; failure → `blocked`, not park.
5. Append a `resume` entry recording what changed.

*Agent resumed ≠ agent still authorized.*

### 6.4 TTL

Absolute lifetime covering running, blocked, and parked time. On expiry → `failed` with `ttl_expired`; releases all locks; queue items removed. Parked tasks do not accumulate indefinitely against an operator who never clears the queue.

---

## 7. Steer

An instruction crossing from one execution context into a different, already-running, already-authorized execution context. **The most dangerous object in JUNO.** Never text appended to a transcript.

### 7.1 Structure

| Field | Notes |
|---|---|
| `id` | |
| `target_task` | ref |
| `principal` | ref |
| `intent` | `amend_objective` \| `add_constraint` \| `narrow_authority` \| `redirect` \| `abort` |
| `payload` | structured |
| `integrity` | Inherited from the composing surface (§7.5) |
| `sensitivity` | `max(composing surface's sensitivity_max, payload sensitivity)` — propagates to the target (§7.7) |
| `timing` | `checkpoint` \| `next_turn` — default intent-dependent (§7.3) |
| `issued_at` | ts |
| `applied_at_seq` | Trajectory sequence it landed on |

### 7.2 Safe checkpoint

The boundary after a capability result has been journaled, the task's state is durable and internally consistent, and the current plan step (per the active Strategy) is complete. Strategy owns the definition; the runtime enforces it.

A `next_turn` steer landing mid-plan-step records the abandoned step as an `abandon` entry with partial work referenced, never discarded. In-flight capability calls are never interrupted; `abort` marks for rollback after return or timeout.

### 7.3 Timing defaults

Intent-dependent. Queuing a safety narrowing behind a checkpoint leaves the unsafe window open by design.

| Intent | Default |
|---|---|
| `amend_objective` | `checkpoint` |
| `redirect` | `checkpoint` |
| `add_constraint` | `next_turn` |
| `narrow_authority` | `next_turn` |
| `abort` | `next_turn` |

Explicitly overridable per steer.

### 7.4 Authorization

1. Steering authority is separate from the target's grants. Reading a task is not steering it.
2. A steer may **narrow** authority. It may never **widen** it.
3. Integrity gates intent:

| Intent | Minimum steer integrity |
|---|---|
| `amend_objective` | `operator` |
| `redirect` | `operator` |
| `abort` | `operator` |
| `add_constraint` | any |
| `narrow_authority` | any |

4. Every steer enters the target's trajectory as a distinct attributed entry.

### 7.5 Composing-surface integrity

- **Every composing surface carries an `integrity_floor`, initialised to `operator`, and a `sensitivity_max`, initialised to `public`** (§3.6).
- Reading any untrusted content into that session **permanently lowers the floor for that session.** No decay by time, no decay by turn count.
- Reading any material into that session **permanently raises `sensitivity_max`** to at least that material's sensitivity. Symmetric to the floor, and it is what §7.7 evaluates.
- A steer composed in that session inherits both.
- **Both are displayed as persistent state**, not hidden in a heuristic. The operator can see, at all times, what the current surface is permitted to do.

**Clearance — two mechanisms, both mechanical:**

| Mechanism | Result |
|---|---|
| **Clean compose** — an isolated input carrying no session context, accepting **keystroke-originated input only** | `operator` integrity |
| **New session** — a fresh surface with no prior reads | Floor resets to `operator` |

**Paste demotion.** Paste, drop, and programmatic insertion into the clean compose surface are detectable events. Any of them demotes the composed steer to the originating session's floor, or to `untrusted` where there is no session. The demotion is disclosed inline at the moment it occurs, not buried in a log.

Without this, cleanliness would be established by layout and inspection — precisely what invariant 7 prohibits. The clipboard crosses surfaces; the mechanism must too.

**Accepted residual, per §0.5:** an operator who retypes injected content by hand defeats this, and nothing can catch it. Retyping is indistinguishable from intending. This is the boundary of any technical control on this path.

**Cost, stated honestly:** after reading a file into a chat session, redirecting a running task requires retyping the redirect in a clean field. Friction by design — the price of a rule that is deterministic and visible rather than heuristic and invisible.

### 7.6 The path this closes

```
file on disk (untrusted)
  → chat reads it            → session integrity_floor drops to untrusted
  → operator composes steer  → steer inherits untrusted
  → intent = redirect        → REFUSED (requires operator integrity)
  → operator pastes into clean compose → demoted to session floor → still REFUSED
```

Untrusted material may be **quoted into** a task as data; it may never **become** instruction.

### 7.7 Steer sensitivity propagation

A steer composed in a session that read `secret` material carries that sensitivity into the target, raising its `sensitivity_floor` mid-run — potentially past what the currently-serving provider permits.

**Before application, every steer is evaluated against the target's `model_policy`:**

- If applying it would raise `sensitivity_floor` beyond the serving provider's permission → park `steer_routing_violation` rather than apply.
- The operator may re-route the task to a permitted provider and resume, or withdraw the steer.
- Applying and then discovering the violation is prohibited: sensitivity is monotonic and cannot be undone.

---

### 7.8 Steer delivery mechanics

§7.2–7.3 describe *when* a steer applies. They never described *how* it physically reaches a running task — and under some provider modes it cannot. v0.4's §7 and §10.2 were individually correct and jointly unimplementable.

Delivery depends on whether JUNO controls the next turn boundary and whether it assembles the context:

| Context mode | Provider | Delivery | `steer_capability` |
|---|---|---|---|
| `owned` | any | Steer inserted into the volatile region of the next assembled context | `full` |
| `native` | `stateless` | JUNO re-sends context each call; steer inserted into the next call | `full` |
| `native` | `server_held`, `turn_control: client` | Steer delivered as an appended message on the next JUNO-initiated turn | `full`, with caveats below |
| `native` | `server_held`, `turn_control: server` | No turn boundary JUNO controls. Only a server-side interrupt can deliver | `checkpoint_only` if an interrupt exists, else `none` |

**`steer_capability` is derived at admission** from the provider profile and the derived `context_ownership`, recorded on the Task (§3.1), and **surfaced to the operator**. The supervisory console must not offer a steer control on a task that cannot receive one — a steer that silently never lands is worse than a disabled button.

**Caveats under `server_held` state**, recorded as accepted residuals per §0.5:

- A delivered steer **cannot be withdrawn.** Once appended, it is in the provider's held context permanently.
- **`abandon` semantics are weaker.** JUNO can record that a plan step was abandoned, but cannot remove the abandoned work from the model's view. The model may continue to reference it.
- Therefore `next_turn` timing on `server_held` providers delivers correctly but does not cleanly excise the interrupted step.

**Admission consequence.** A task requiring responsive `next_turn` steering — typically anything the operator expects to supervise live — must be routed to a provider offering `full` capability. This is checked at admission (§5.4 check 11), not discovered at runtime.

**The incentive survives.** Tasks wanting fast steer responsiveness have a routing reason to prefer providers and capability sets that also give `native` context ownership and prompt caching. §10.2's cheap-path-safe-path property is unaffected.

---

## 8. Override

### 8.1 Structure

| Field | Notes |
|---|---|
| `id` | |
| `target` | A parked task, **or** an admission-time check |
| `overridden_check` | The specific park reason **or** admission check being cleared |
| `principal` | ref |
| `justification` | **Mandatory free text.** Not a checkbox |
| `risk_disclosed` | The structured risk statement shown, stored verbatim |
| `acknowledged_at` | ts |

Generalised from v0.3, where Override targeted only parked tasks while §5.3 already required one at admission.

### 8.2 Invariants

- **Per-invocation only.** One check, once. No "always allow", no class-wide override, no remembered preference.
- **Justification mandatory and free-form.** A one-click override is a disabled control.
- **The risk statement shown is stored verbatim**, so it is possible to see afterward exactly what was disclosed at the moment of decision. Responsibility transfer is recorded, not assumed.
- Overrides enter the trajectory as `override` entries.

### 8.3 Non-overridable checks

**The general rule, which explains all three:**

> **A park is non-overridable when the operator cannot observe the consequence of proceeding.**

Every other park reason presents the operator with a visible, bounded outcome — this grant, this file, this cost. The three below do not: proceeding produces a harm the operator has no way to see at the moment of decision, and the automation-bias evidence (§0.4) says an unobservable harm behind a persuasive prompt will be accepted. In each case a structural remedy exists, and the remedy is the path.

**`integrity_floor`** — when an `instruction` field was synthesized from untrusted content, the operator cannot visually distinguish an injected instruction from a clean one. That is the nature of the attack, and the automation-bias evidence says a persuasive presentation will be accepted.

The remedy is structural, and both paths are available to autonomous tasks:
1. Use a typed capability with the value in a `data` field (§2.2).
2. Pass the value as a `bound` reference rather than synthesized text (§2.6).

Where neither applies and no operator is present, the task parks until one is. Intended behaviour.

**`adapter_quarantined`** — an adapter that forfeited registration under §2.4 is constructing parsed strings from `data` values. The operator cannot see which of its calls are safe, because the defect is in string construction the operator never observes. Remedy: repair the adapter, or route the capability to a conforming provider.

**`steer_routing_violation`** — applying the steer would send material above the sensitivity ceiling to a provider that persists it server-side, under a retention policy JUNO cannot enumerate or reverse. The harm is entirely invisible: nothing observable happens at the moment of approval, and sensitivity is monotonic so it cannot be undone. Remedies, both already specified: re-route the task to a provider satisfying §10.3 and resume, or withdraw the steer.

*Note the shape: none of these three is "too dangerous to allow." Each is "impossible to evaluate at the moment of decision." That is a different and stricter criterion, and it is the one that matters given §0.4.*

### 8.4 Override rate has a response

| Condition | Response |
|---|---|
| Override rate on a single check exceeds threshold over a rolling window | Generate a **policy-review artifact** naming the check, the tasks, and the justifications given |
| Policy-review artifact unaddressed for two windows | Surface as an individual notification outside the batched queue |

A metric with no response is decorative. Sustained overriding means the policy is wrong, not that the runs were exceptional.

---

## 9. Budgets

| Scope | Axes | Exhaustion |
|---|---|---|
| **Task** | tokens, currency, wall-clock, turns | Park `budget_exceeded` |
| **Child task** | Drawn from and bounded by parent's remaining budget on every axis | Park; spend attributed to child, charged to parent chain |
| **Estate (daily)** | **currency and tokens** | Park all running autonomous tasks with `estate_budget_exceeded` |

Two estate axes, not one: a currency-only ceiling is escaped by token runaway on a cheap provider, and token volume is itself a risk signal independent of price.

Gated tasks are not parked by estate exhaustion but must surface the condition at their next approval.

### 9.1 Estate recovery

Estate exhaustion parks every autonomous task simultaneously. Naive recovery resumes them all at once — synchronised lock re-acquisition, a provider burst, and a fresh day's budget consumed instantly by whichever resumes first.

**Recovery is serial and metered:**

1. Parked-by-estate tasks resume one at a time, in §12 ordering (irreversibility, then budget at risk, then age).
2. Remaining estate budget is re-evaluated before each resumption.
3. Resumption halts once a configured fraction of the daily budget is committed — default 50%. The remainder stay parked as `estate_deferred`.
4. Resumption is automatic and does not consume a queue-clearance interruption.
5. **`estate_deferred` tasks appear in a status view, not the decision queue.** They require no operator action and will resume on their own; placing them in the queue would inflate a batch with items that need nothing, which is exactly the habituation surface §12 exists to avoid.

---

## 10. Context assembly and routing

### 10.1 Rules

1. **Never re-order or re-rank the stable region.** Doing so forfeits the prompt cache and pays full recompute.
2. **Hard-constraint filtering runs before any relevance ranking** in both regions: scope → authorization → sensitivity → temporal validity, *then* relevance.
3. `next_turn` steers land in the volatile region.
4. **Cache hit rate is tracked** (§13.2).

### 10.2 Context ownership is derived, not chosen

Computing the integrity of a `synthesized` argument requires knowing the volatile region. A provider that owns the context does not tell us.

Two conditions, both with stated causes:

| Condition | `context_ownership` |
|---|---|
| Task's Strategy and capability set permit only `constant` and `bound` arguments in `instruction` fields | `native` — consume provider context management; keep the cache |
| Task may synthesize `instruction`-field arguments, **or** `replay_fidelity: full` is required | `owned` — JUNO assembles and hashes the context; forgo native compaction |

*v0.3 carried a third condition — `sensitivity ≥ confidential` forces `owned` — with no stated rationale. It was misfiled rather than wrong; the real concern is provider-side retention, which is a routing constraint. See §10.3.*

**The most useful property in the model: the cheap path is the safe path.** Typed capabilities plus bound references get provider-native context management and prompt caching. Raw shell plus synthesized command strings pay for owning their own context. Cost pressure and safety pressure point the same direction — so the design does not depend on operator discipline holding across irregular build sessions months apart.

### 10.3 Sensitivity routing constraint

Server-held conversation state means the provider persists the assembled context on their infrastructure, under their retention policy, in a form JUNO cannot enumerate or delete. That conflicts directly with retention-by-sensitivity (§3.4.5) and with any deletion obligation.

> **`sensitivity_floor ≥ confidential` requires a provider with `conversation_state: stateless`.**

A constraint on `model_policy`, evaluated at admission (check 5) and re-evaluated at resume and on steer application (§7.7). Unsatisfiable → reject at admission, park `routing_unavailable` mid-run.

Note this is independent of context ownership: a provider may offer native compaction while remaining stateless per call.

**Honest cost note — this is the one place the cheap path is not the safe path.** Stateless providers have historically offered weaker or no transparent caching, so `confidential`+ tasks may pay full-context cost per turn while `public` tasks enjoy the cache. Cost pressure therefore points *against* the safe routing for exactly the highest-stakes material. Recorded here so that a future session does not "fix" the cost problem by relaxing §10.3.

**Mitigation, already available:** client-side `owned` assembly composes cleanly with explicit provider-side cache breakpoints on stateless prefix-caching APIs. The penalty is avoidable with deliberate effort; it is not structural. **Cache hit rate is therefore tracked segmented by sensitivity** (§13.2), so the penalty is measured rather than assumed.

---

## 11. Approval surface

Interface design produced a larger effect on review quality than volume did (Akhawe & Felt 2013: ~10% to 70.2% click-through on presentation alone).

### 11.1 Requirements

| Requirement | Rationale |
|---|---|
| State the **specific effect**, not the capability name | "Delete 47 files in `/src`" not "shell.run requested" |
| State **irreversibility explicitly** where `side_effect = irreversible` | The main decision input |
| Show **per-argument provenance and integrity** | Plausibility is not a safety signal |
| Show **what was already decided at admission** | Distinguishes policy gaps from genuine exceptions |
| **Accountability framing** — what the operator is taking responsibility for | Mosier et al. 1996 |
| **No default-affirmative control.** No pre-selected "approve" | Removes the one-click path |
| Differentiate visually by `side_effect` class | Undifferentiated prompts habituate |

### 11.2 Anti-requirement

The approval surface must **not** summarize or persuade. A confident rationale raises acceptance without raising correctness. Present facts and provenance; let the operator decide.

---

## 12. Decision queue

| Property | Rule |
|---|---|
| Accumulation | A park enqueues; it does not notify individually |
| Interruption budget | Configurable; default **5 per day**, per D9 |
| Batching | Clearing the queue is **one** interruption event |
| **Irreversible items are never batched** | Presented individually. A twelve-item batch is a habituation surface |
| Maximum batch size | Configurable; above it, split into separate presentations |
| Ordering | Irreversibility, then budget at risk, then age |
| Escalation | An item nearing its task's `ttl` escalates to individual notification |
| Not enqueued | `blocked` tasks (§3.3) and estate-deferred resumptions (§9.1) |
| Empty-queue behaviour | No notification. Silence is the default state |
| **Authority** | `queue.clear` is an authority held by the principal; delegable at D4 |

The 5/day figure is operator preference. No literature supports any specific number (§0.4). A configured constant, never a derived safety threshold.

---

## 13. Provider profiles, ablation, and instrumentation

### 13.1 Provider Capability Profile

Configuration data, not code. Adding a provider must never require a release.

| Field | Why it matters |
|---|---|
| `mid_stream_cancellation` | Whether `abort` can stop an in-flight generation |
| `prompt_cache` | `{supported, granularity, ttl}` |
| `conversation_state` | `stateless` \| `server_held` — **gates `confidential`+ work** (§10.3) |
| `turn_control` | `client` \| `server` — who initiates the next turn. **Determines steer deliverability** (§7.8) |
| `server_interrupt` | Whether a server-driven loop can be interrupted mid-run. Only relevant when `turn_control: server` |
| `replay_fidelity` | `full` \| `partial` \| `none` — a routing input |
| `native_tool_calling` | `{supported, parallel}` |
| `native_context_management` | Whether §10.2 `native` ownership is available |
| `context_window` | Budget ceiling |
| `cost` | Per token in / out / cached |
| `jurisdiction` | Data residency |

### 13.2 Tracked metrics

| Metric | Response when out of range |
|---|---|
| Approvals per day | Against the D9 ceiling |
| Override rate by check | Policy-review artifact (§8.4) |
| **Grant breadth** — scope size, invocation caps, expiry length | Rising breadth means admission concentration is degrading into blanket authorization |
| **Raw-shell invocation count** | Each use signals a missing typed capability. Should trend to zero |
| **Interpreter-program invocation count** | Same, and higher severity (§2.3) |
| **Adapter quarantines** | A quarantine is a §2.4 violation shipped into production |
| Cache hit rate, **segmented by sensitivity** | §10 health, and the §10.3 cost penalty measured rather than assumed |
| `steer_capability` distribution across admitted tasks | How much of the estate is actually steerable — the product depends on it |
| Cost per completed task, by closure mode | Unit economics |
| Park rate by reason; block rate and blocked duration | Where policy coverage is thin; where contention is real |
| Closure mode distribution | How much work is genuinely verified |
| Registration contradictions | §1.4 |
| Time-to-completion, measured | Not estimated — §13.4 |

### 13.3 Ablation panel — with a refresh policy

- Frozen set of 20–30 representative tasks with fixed success validators.
- On **every frontier model release**, run under (a) a thin reference harness and (b) the current JUNO harness.
- A component whose thin-vs-current gap has closed across two consecutive releases is **retired**.
- **Refresh policy:** validators re-checked against current dependencies each quarter. Any validator failing for environmental rather than harness reasons is repaired or replaced, and the replacement is a **dated artifact**. Panel drift is recorded, not absorbed.
- A panel whose maintenance burden exceeds its signal is retired and rebuilt rather than patched indefinitely.

### 13.4 Operator calibration

Self-assessment inverts reality (Perry 2023; METR 2025). **JUNO measures its own effect on the operator rather than asking.** Time-to-completion and defect-discovery are instrumented from the trajectory. Operator satisfaction is not a metric.

---

## 14. Do-not-build list

Seven harness functions migrated into provider APIs with dated primary evidence. **This list exists to prevent scope creep across irregular build sessions.**

| Do not build | Native since | Note |
|---|---|---|
| Tool-call parsing | 2023-06 | Universal and superior natively |
| Retrieval orchestration | 2023-11 → 2024-04 | Custom only at the regulated/high end |
| Computer-use drivers | 2024-10, GA 2026 | Fastest migration observed |
| Single-context planning | 2025-02 | Harness control knob subsequently deprecated |
| Sub-agent delegation (basic) | 2025-03 / 2025-09 | Topology and cost control remain ours |
| Context compaction | 2025-09 | Native preserves prompt cache — but see §10.2 |
| Basic file-based memory | 2025-09 / 2026-04 | Carve-out below |

**Memory carve-out, with criteria.** Build custom memory **only** where the native store cannot express: cross-task entity identity, retention indexed by data class, or per-entry provenance. Absent one of those three, use native.

**Exception rule, applying to every row:** build a custom version only when a **dated, controlled measurement on your own task panel** shows the native version underperforming by a margin justifying the maintenance. Never build first and compare later.

**Still ours:** authority and authorization, audit and evidence, durable persistence, policy enforcement, provider-independent capability naming, cost control, multi-provider routing, verification loops.

---

## 15. Deferral schedule

| Deferred | Approximate trigger |
|---|---|
| Subagent fan-out and orchestration | v1.1 — grants and budgets already attenuate |
| Workflow engine / durable execution | v1.1 — when Park/Resume is used to fake multi-step orchestration |
| Third-party plugin distribution, signing, sandboxing | v1.2 — gates the open-source release |
| Computer use / observation–action loop | v1.2 — needs isolation tier 5 proven first |
| Multi-tenancy, sharing, org structure | v2.0 — gates the hosted product (D4) |
| Billing, quota, subscription | v2.0 |
| Realtime stream sessions | v2.0 or on demand |
| Sync / multi-device | v2.0 |
| Voice, image, multi-modal I/O | Unscheduled |

**Permanent retrofit-proofing (D4):** principal is an explicit object even with one user; no operator-machine assumptions anywhere; policy is data, never code.

---

## 16. First-run disclosure

1. The seven invariants (§0.3), in plain language.
2. What is recorded: every action, its cost, its provenance, its outcome; that the record is the primary safeguard.
3. What the operator is responsible for: grants issued, overrides taken, tasks closed under `accepted`, criteria accepted at `operator` integrity.
4. What JUNO will not do: act when unsure, hold credentials in the model, or mark its own work complete.
5. **The accepted residuals** (§0.5): retyped content defeats paste demotion; replay is comparable, not identical; registration and capability declarations are trusted because they are few and operator-authored.

Acceptance recorded with timestamp and disclosure version.

**Caution, recorded deliberately:** a disclosure is not a control. It must never appear in a design rationale as justification for a missing mechanism.

---

## 17. Open decisions

| # | Decision | Blocks |
|---|---|---|
| O3 | Telemetry stance for shipped builds | D4; not urgent |
| O4 | Default shipped policy — D6 relocated breadth-vs-blast-radius onto the policy author; for strangers that is you | D4; not urgent |
| O5 | Budget enforcement granularity below task level | Refinement |
| O7 | Verification methods for non-coding workloads. RB-2 not run | Any second workload |
| O8 | Failure attribution taxonomy. RB-3 not run; answerable from local trajectory data once any exists | Harness improvement loop |
| O10 | **Surface contract beyond the §3.6 stub** — sharing, lifetime, revocation of `journal_read` | Slice 2 / supervisory console |

**O9 resolved.** Syntax `${<seq>.<path>}` where `<seq>` is a trajectory sequence number within the same task and `<path>` is a JSONPath-style accessor into that entry's payload. Runtime rejects references that are unresolvable, ambiguous, or cross-task. Chosen for auditability over expressiveness: a reference is readable in the journal without tooling.

*O1 resolved (§7.3). O2 resolved (D11, §4.2). O6 resolved (§10.2). O9 resolved above.*

---

## 18. First build slice

**One task, end to end.**

Task record with objective, criterion, `criterion_integrity`, verification command, attendance flag, `sensitivity_floor`, budget, `ttl`. One typed capability — `shell.run(program: enum, argv: list<string>, cwd: path)` — with field roles declared, an interpreter-free enum, and an adapter using `execve` argv arrays. One Grant, pre-issued, path-scoped, with mandatory expiry. Append-only hash-chained trajectory **written by the runner from outside the worktree, in a namespace no selector can address**, exposed through a read interface that is not a Capability. Park on: `awaiting_grant`, `integrity_floor`, `budget_exceeded`, `ttl_expired`. Verification runs the declared command. Closure written by the runner, never the model. Resume re-authorizes. Terminal only, one provider, no UI.

**Deliberately included despite looking like extras.** Field roles, argument provenance, the adapter structural-channel contract with its conformance suite, and the external journal namespace are all structural — retrofitting any of them means rewriting the enforcement boundary.

**Deliberately excluded.** Steer, Override, the decision queue, resource locking, estate budgets, and the Surface contract. One task cannot contend with itself, cannot be steered while nobody is watching it, and needs no queue. These land in slice 2 alongside the supervisory console, which is what makes them meaningful.

**Acceptance tests:**

1. Park a task, close the laptop, return the next day, resume it, and read a trajectory answering what happened and why — without consulting memory or any external system.
2. Give the task an objective that induces it to synthesize a command string from file contents. It must park with `integrity_floor` and must not be overridable.
3. Give it an objective requiring a filename discovered at runtime, passed as a `bound` reference into `argv`. It must complete without parking.
4. **(a) Governance.** Attempt to add `sh` to the `program` enum. Registration review must reject the change under §2.3.
   **(b) Mechanism.** Force the enum change through, then run an objective reaching for `sh -c`. The code-bearing argv position must be promoted to `instruction` role and the task must park with `integrity_floor`.
5. **Adapter conformance.** Register a deliberately non-conforming adapter that interpolates an argv value into a command string. The §2.4 conformance suite must block registration before any task can use it.

Test 2 proves the injection defence fires. Test 3 proves autonomy survives it. Tests 4a and 4b prove the defence cannot be walked around through the typed front door — 4a via review, 4b via mechanism, which are different components. Test 5 proves the adapter contract is a control rather than a convention.

**If all five pass, the hardest part of JUNO is done.**

---

## 19. What this model asserts, in one paragraph

JUNO owns five objects — **Task, Capability, Grant, Evidence, Artifact** — one index (**data class**), and five governed transitions (**Park/Resume**, **Steer**, **Override**, **queue clearance**, **verification triggering**). Models, providers, protocols, sandboxes, and storage engines are adapters behind them, bound by a structural-channel contract that makes the injection defence a control rather than a convention. Integrity governs what may become instruction; scope governs what data may be reached; provenance is established by mechanism rather than inspection; and trust is placed only on things that are few, static, and operator-authored. Work is admitted only when it can be checked, executed only under authority issued before the fact, suspended rather than degraded when policy cannot be satisfied, supervised through a live trajectory written beyond its own reach, and closed only by an actor other than the one that performed it — with the strength of that closure recorded honestly. A park is non-overridable exactly when the operator could not observe the consequence of proceeding. Approval is a signal; the record is the safeguard. Everything the operator delegates, to any model, agent, or service, leaves behind a durable, attributable, replayable account of what happened.

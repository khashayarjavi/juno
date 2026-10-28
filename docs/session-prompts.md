# Session prompts

Copy and paste these into a new Claude Code cloud session. Pick one per session.

---

## 1. First session ever (Increment 0)

```
This is the first build session for JUNO.

Read CLAUDE.md first and follow it exactly. Then read STATE.md,
spec/slice-1-build-plan.md (Increment 0), DECISIONS.md, and the
sections of spec/core-semantic-model.md that Increment 0 depends on
(§0, §2.4, §3.4.1, §18).

If spec/core-semantic-model.md is missing, stop and tell me.

Create the branch inc-0-scaffold and build Increment 0 only.
Update STATE.md and commit after each meaningful step, because my
usage limit can cut this session off at any time.

When the done-when is met and `make verify` is green, open a pull
request into main using the description format in CLAUDE.md, then
give me the end-of-session report.
```

---

## 2. Every later session

```
Read CLAUDE.md and follow it exactly.

Read spec/core-semantic-model.md and STATE.md before doing anything.

STATE.md tells you which increment is current and what is left in it.
The semantic model is the specification — implement from it, do not
improvise. If you believe the model is wrong or ambiguous, write the
objection into STATE.md and stop; do not resolve it yourself.

Work only on the current increment. Do not start the next one.
If a branch for this increment already exists, continue on it;
otherwise create inc-<N>-<short-name>.

Before you finish:
  1. Run `make verify`. It must be green.
  2. Update STATE.md: what you completed, what remains, anything you
     discovered that a future session needs.
  3. Record any decision not already in the semantic model in
     DECISIONS.md, with its reason.

If `make verify` is red when you stop, write the exact failure into
STATE.md. Do not describe it as done.

If the increment is done and green, open the pull request as
CLAUDE.md describes. End with the end-of-session report.
```

---

## 3. Independent review before merging (Increments 4, 5 and 7)

These three carry the security properties. Run this in a **fresh** session so the reviewer did not write the code.

```
You are reviewing, not building. Do not change any code.

Read CLAUDE.md, spec/core-semantic-model.md, spec/slice-1-build-plan.md
and DECISIONS.md. Then review the open pull request for Increment <N>.

Check, and report each as PASS / FAIL / UNCLEAR with the file and line:
  1. Every test listed for this increment in the build plan exists and
     asserts the model property, not an implementation detail.
  2. No test was weakened, skipped, or deleted.
  3. The lint rule banning exec / execSync / shell:true / template-literal
     commands is intact and not disabled anywhere.
  4. Nothing out of scope for Slice 1 was added (CLAUDE.md rule 9).
  5. Any behaviour the spec does not define is either recorded in
     DECISIONS.md or raised as an objection — not silently chosen.
  6. The workload container still has no network, runs non-root,
     drops all capabilities, and cannot see the journal volume.

End with one line: MERGE, or DO NOT MERGE and why, in plain language.
```

---

## 4. When a session stopped on an objection

Don't let the coding agent answer its own objection. Copy the objection from `STATE.md` into your JUNO planning chat and decide it there. Then start a session with:

```
The objection in STATE.md about <topic> is resolved as follows:
<decision>.

Record this in DECISIONS.md as the next D-number, remove the objection
from STATE.md, then continue the current increment following CLAUDE.md.
```

# spec/

Read-only inputs. The coding agent never edits these files.

| File | What it is | Status |
|---|---|---|
| `core-semantic-model.md` | JUNO Core Semantic Model **v0.5.1** — the specification | **Must be added by the operator** (see below) |
| `slice-1-build-plan.md` | The Slice 1 build plan, increments 0–7 | Present |
| `roadmap-after-slice-1.md` | Where the design goes after Slice 1. Context only. | Present |

## Adding the semantic model

The final v0.5.1 file was produced in the August 2026 design chat ("JUNO J harness project analysis") as `juno-core-semantic-model-v0.5.1.md`. Download it from that chat, rename it to `core-semantic-model.md`, and commit it here.

Check you have the final version: it should contain the trust-relocation principle (§0.5) and, in §8.3, a sentence noting that §3.2's wildcard-egress prohibition uses the same "operator cannot observe the consequence" criterion. That sentence was the last edit made, so a file without it is an earlier draft.

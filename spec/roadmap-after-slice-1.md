# Roadmap after Slice 1 — context only, DO NOT BUILD

> **For the coding agent:** this file explains where the design is heading so you don't make choices in Slice 1 that block it. It is **not** a work list. Do not build, stub or scaffold anything here during Slice 1. If a Slice 1 choice would block something below, write it as an objection in `STATE.md` and stop.

Source: *JUNO Strategic Review — October 2026* (operator's planning doc). Decisions there are pending operator confirmation unless marked otherwise.

---

## Slice 1.5 — Govern the harnesses the operator already uses

JUNO's own agent loop is one way in. Two more ways in reuse the same enforcement boundary and journal:

| Mode | How work enters | What it cannot do |
|---|---|---|
| A — own loop (Slice 1) | JUNO runs the model and the turn loop | — |
| B — gateway | An MCP proxy: every tool call from any MCP client passes JUNO's grant checks and is journaled | No steer, no context ownership |
| C — hook | Claude Code pre-tool-use / post-tool-use hooks call JUNO, which answers allow / deny / park and journals the result | No steer, no context ownership |

The `steer_capability` table (§7.8) gains two rows, `gateway` and `hook`, both `none` — now in spec v0.6. **Acceptance and the rules for these modes are in spec v0.6 §4.3**, which supersedes the draft acceptance that stood here.

**What this means for Slice 1:** keep enforcement and journaling callable from code paths other than the runner's turn loop. Don't weld them to it.

---

## Slice 2 — Console and surfaces

Supervisory console; the Surface contract (O10); Telegram as the first phone surface for parks and a daily digest; Steer and Override; decision queue; resource locking.

---

## Slice 3 — JUNO Bots (always-on agents)

Governed equivalents of OpenAI Dots and Grok Bot. Each Bot is a **standing Task** with its own sandbox, triggers, governed memory and pre-signed Grants.

| Sub-slice | Delivers |
|---|---|
| 3a | Standing tasks with budgets per period, scheduler, event triggers, Telegram digest |
| 3b | Governed memory (entries are Artifacts: data-classed, viewable, editable, deletable) and skill promotion (a Bot drafts a skill; the operator approves it into the registry) |
| 3c | Sandboxed browser with a GUI capability class (needs a v0.6 design pass first) |
| 3d | Bot teams with handoffs (delegation with integrity and sensitivity carried down the chain; D-006's test becomes mandatory) |

Key rules already decided in principle:
- **Memory poisoning:** anything learned while a session's integrity floor is lowered is stored as `data`, never `instruction`, and never widens a Grant.
- **Interruption ceiling (<5/day) still holds:** non-urgent parks batch into one capped daily digest; repeated approvals produce a *proposed* Grant the operator signs, never an automatic one.
- **GUI actions** are always gated, never pre-grantable, until the GUI capability class is designed.

**What this means for Slice 1:** don't assume tasks always have a fixed end, and don't assume every run starts from an operator message. Budgets and TTLs should be values a future standing task could reset per period, not constants.

---

## Queued for the v0.6 design pass (after Slice 1 produces trajectory data)

- Standing tasks and per-period budgets
- GUI-action capability class (observe before act)
- A2A peers as a Capability kind, with an inbound trust class
- Grant fields compatible with payment mandates (signed intent, cap, expiry)

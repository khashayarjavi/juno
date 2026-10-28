# Operator runbook

What you do to build JUNO with Claude Code cloud sessions. You never need to read code.

---

## A. One-time setup (about 30 minutes)

1. **Create a private GitHub repository** named `juno`. Leave it empty (no README, no licence).
2. **Add the starter kit:** put every file from this kit in the repo root, including the hidden `.claude/` and `.github/` folders.
3. **Add the specification:** download `juno-core-semantic-model-v0.5.1.md` from the August design chat, rename it `core-semantic-model.md`, and put it in `spec/`. See `spec/README.md` for how to check it's the final version.
4. **Commit and push** to `main`.
5. **Install the Claude GitHub App** on the `juno` repository: <https://github.com/apps/claude>. Cloud sessions need it to clone the repo and open pull requests.
6. **Create the cloud environment** in the Claude desktop app: start a new Code session, choose **Cloud** in the environment selector, add an environment:
   - Name: `juno`
   - Network access: **Trusted**
   - Setup script: paste the contents of `docs/cloud-environment-setup.sh`
   - Environment variables: none
7. **Optional but recommended:** in GitHub → Settings → Branches, protect `main` and require the `verify` check to pass before merging.

---

## B. Every build session

1. In the desktop app, start a new Code session → **Cloud** → environment `juno` → repository `juno`.
2. Paste a prompt from `docs/session-prompts.md`:
   - very first session: prompt 1
   - every session after: prompt 2
3. Let it work. Answer if it asks you something. You can close the laptop; the session keeps running.
4. When it finishes, read its end-of-session report.

**If it hits your usage limit:** nothing is lost. `STATE.md` holds the progress. Wait for the limit to reset, then start a new session with prompt 2. Type `/status` in a session to see how much usage you have left.

---

## C. Accepting an increment

An increment is done only when **all three** are true:

1. The pull request's **verify** check is green on GitHub.
2. `STATE.md` on the branch says the increment is done.
3. For Increments **4, 5 and 7**: an independent review (prompt 3, in a fresh session) ends with **MERGE**.

Then merge the pull request. The next session starts the next increment.

If the check is red, don't merge. Start a new session with prompt 2; it reads the failure from `STATE.md`.

---

## D. Stop signs

Stop the session and bring the problem to your JUNO planning chat if the agent:

- edits anything in `spec/`
- disables, weakens or deletes a test or the lint rule
- adds anything from the out-of-scope list in `CLAUDE.md`
- says something is done while `make verify` is red
- writes an objection to the spec (that's correct behaviour, but you decide the answer in the planning chat, not the coding session; see prompt 4)

---

## E. Rough timeline on Pro

| Increment | What it builds | Est. sessions |
|---|---|---|
| 0 | Scaffold, lint rule, containers, `make verify`, CI | 2–3 |
| 1 | Contracts and the data-class lattice | 3–4 |
| 2 | Journal | 2–3 |
| 3 | Registry, adapters, conformance suite | 3–4 |
| 4 | Enforcement boundary (+ review) | 4–5 |
| 5 | Runner (+ review) | 4–5 |
| 6 | Resume | 2–3 |
| 7 | Acceptance tests (+ review) | 2–4 |
| **Total** | | **22–31** |

At about 5 sessions a week that is roughly 5–6 weeks. One "session" here means working until the 5-hour usage limit; actual allowances aren't published, so treat these as estimates and update them after Increment 0.

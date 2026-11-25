# Reporting a vulnerability

JUNO is a security boundary, so please report a vulnerability **privately**, not in a public issue, pull request or discussion.

**How:** use GitHub's private vulnerability reporting for this repository: the **Security** tab, then **Report a vulnerability** (`https://github.com/khashayarjavi/juno/security/advisories/new`). Only the repository's maintainers see the report.

**Please include:**
- what an attacker can do, and from where: the agent, the workspace, another local user, the network, or someone with the runner's account;
- the commit you tested (`git rev-parse HEAD`), the mode (JUNO's own loop, Claude Code's hook, or the MCP gateway), and the steps to reproduce;
- whether it needs a condition `docs/evidence/slice-1.5.md` already lists as a residual (for example root changing JUNO's files, or a file system with case folding).

**What happens next:** the report is read, and a fix is built with a test that proves it. The fix is merged only through the project's usual gate: `make verify` green in CI and an independent review. The advisory is then published with credit, unless you ask not to be named.

**Out of scope:** what `docs/evidence/slice-1.5.md` states JUNO does not protect (for example a Claude Code session started outside the governed terminal), and anything that needs the operator's grant-signing key.

Please do not test against anyone else's installation, and do not post exploit details publicly before a fix is merged.

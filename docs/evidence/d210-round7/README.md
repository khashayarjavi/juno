# Review round 7 on PR #51: the four reproductions (D-210)

Written by the round 7 reviewer, against head a47eab4. Each asserts the safe outcome and fails on that head.
They are stored as `.txt` so that `make verify` and the lint rule do not pick them up. To run one: copy it, without
`.txt`, into a scratch folder with `vitest.config.mjs`, and run `npx vitest run --config <scratch>/vitest.config.mjs`
from the repository root. Their output is `repro-output.txt`.

- `fakegit.test.ts`: F1, a git program of the runner's own named with `--git`.
- `insteadof.test.ts`: F2, the clone's own git settings changed while the service runs.
- `toctou.test.ts`: F3, the symbolic-link swap of round 6's D3, timed between the start-up check and the journal's opening.
- `crash2.test.ts`: F4, a second power loss during the torn-write repair.

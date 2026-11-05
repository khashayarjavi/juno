// Inside the e2e container (D-145): start the scripted server on loopback, then run the real Claude Code binary in -p
// mode against it, with a throwaway key and nonessential traffic off. execFile with an argv array; no shell.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const [sessionId, prompt] = process.argv.slice(2);
const port = "18765";
const server = execFile("/usr/local/bin/node", ["/e2e/messages-server.mjs", "/run-e2e/script.json", "/run-e2e/requests.log", port], () => {});
for (let tries = 0; tries < 100 && !(existsSync("/run-e2e/requests.log") && readFileSync("/run-e2e/requests.log", "utf8").includes("listening")); tries += 1) await sleep(100);
const child = execFile(
  "/opt/claude-code/bin/claude",
  ["-p", prompt, "--session-id", sessionId, "--output-format", "json"],
  {
    cwd: "/workspace/project",
    timeout: 120_000,
    env: {
      HOME: "/home/claude",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: `sk-e2e-not-a-key-${Math.random().toString(36).slice(2)}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
  (error, stdout, stderr) => {
    writeFileSync("/run-e2e/claude.out", stdout);
    writeFileSync("/run-e2e/claude.err", stderr);
    server.kill();
    process.exitCode = error === null ? 0 : 1;
  },
);
child.stdin?.end();

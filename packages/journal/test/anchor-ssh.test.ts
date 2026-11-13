import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { knownHostsRefusals, parseAnchorPin, pinnedTransport, sshFingerprint } from "../../enforcement/src/anchor-pin.js";
import { executeOutbound } from "../../registry/src/index.js";
import { GitAnchorSink, SSH_ENVIRONMENT, anchorOf, readAnchorDirectory, sshInvocation, taskDigest } from "../src/index.js";
import { main } from "../src/anchor-ssh.js";

/**
 * Operator ruling D-206 item 2 (DECISIONS.md D-208): the anchor repository is reached over SSH with the pinned host key
 * and nothing of the runner's own SSH or git settings. Rule 13: what git and OpenSSH do with these options is shown
 * with the real programs, not assumed. (No SSH server is contacted: git is given a recording program as `GIT_SSH`, and
 * the real `ssh -G` prints the configuration it would use without connecting.)
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-anchor-ssh-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENV = { [SSH_ENVIRONMENT.program]: "/usr/bin/ssh", [SSH_ENVIRONMENT.knownHosts]: "/etc/juno/anchors_known_hosts", [SSH_ENVIRONMENT.pushKey]: "/home/juno-runner/.ssh/juno_anchors" };

describe("D-206 item 2: SSH to the anchor repository uses the pinned host key only", () => {
  // proves D-208: the options that take the server's identity out of the runner's hands are all present, before git's own arguments
  it("builds ssh's arguments from the pinned files and git's own arguments", () => {
    const built = sshInvocation(["git@github.com", "git-upload-pack 'me/juno-anchors.git'"], ENV);
    if ("refusal" in built) throw new Error(built.refusal);
    expect(built.file).toBe("/usr/bin/ssh");
    expect(built.args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    for (const option of ["StrictHostKeyChecking=yes", "UserKnownHostsFile=/etc/juno/anchors_known_hosts", "GlobalKnownHostsFile=/dev/null", "KnownHostsCommand=none", "VerifyHostKeyDNS=no", "UpdateHostKeys=no", "IdentitiesOnly=yes", "IdentityAgent=none", "IdentityFile=/home/juno-runner/.ssh/juno_anchors", "BatchMode=yes"]) {
      expect(built.args[built.args.indexOf(option) - 1], option).toBe("-o");
    }
    expect(built.args.slice(-2)).toEqual(["git@github.com", "git-upload-pack 'me/juno-anchors.git'"]);
  });

  // proves D-208 (fail-closed): without all three pinned paths, or with a path ssh would read as more than a path, nothing is run
  it("refuses to build arguments from missing, relative or unsafe paths", () => {
    expect(sshInvocation(["h", "c"], {})).toHaveProperty("refusal");
    expect(sshInvocation(["h", "c"], { ...ENV, [SSH_ENVIRONMENT.knownHosts]: "known_hosts" })).toHaveProperty("refusal");
    expect(sshInvocation(["h", "c"], { ...ENV, [SSH_ENVIRONMENT.knownHosts]: "/etc/juno/a b" })).toHaveProperty("refusal");
    expect(sshInvocation(["h", "c"], { ...ENV, [SSH_ENVIRONMENT.pushKey]: "/home/%u/key" })).toHaveProperty("refusal");
  });

  // proves D-208 with rule 13: the real OpenSSH client accepts every option and reports the configuration JUNO means:
  // only the pinned known-hosts file, strict checking, only the pinned key, no agent, no prompts
  it("is the configuration the real ssh reports for these arguments", async () => {
    const built = sshInvocation(["-G", "git@github.com"], ENV);
    if ("refusal" in built) throw new Error(built.refusal);
    const result = await executeOutbound({ file: built.file, args: built.args });
    expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
    const config = new Map(result.stdout.toString("utf8").split("\n").map((line) => { const at = line.indexOf(" "); return [line.slice(0, at), line.slice(at + 1)] as const; }));
    expect(config.get("stricthostkeychecking")).toBe("true");
    expect(config.get("userknownhostsfile")).toBe("/etc/juno/anchors_known_hosts");
    expect(config.get("globalknownhostsfile")).toBe("/dev/null");
    expect(config.get("identityfile")).toBe("/home/juno-runner/.ssh/juno_anchors");
    expect(config.get("identitiesonly")).toBe("yes");
    expect(config.get("identityagent")).toBe("none");
    expect(config.get("batchmode")).toBe("yes");
    expect(config.get("verifyhostkeydns")).toBe("false");
    expect(config.get("updatehostkeys")).toBe("false");
    // `none` is how ssh is told there is no such command; it then reports none.
    expect(config.has("knownhostscommand")).toBe(false);
    expect(config.get("hostname")).toBe("github.com");
  });

  // proves D-208: the wrapper answers the program's own exit code, and fails closed when it cannot run it
  it("runs the program and answers its exit code", async () => {
    const said: string[] = [];
    expect(await main([], { ...ENV, [SSH_ENVIRONMENT.program]: "/bin/true" }, (text) => said.push(text))).toBe(0);
    expect(await main([], { ...ENV, [SSH_ENVIRONMENT.program]: "/bin/false" }, (text) => said.push(text))).toBe(1);
    expect(await main([], { ...ENV, [SSH_ENVIRONMENT.program]: "/no/such/ssh" }, (text) => said.push(text))).toBe(255);
    expect(await main([], {}, (text) => said.push(text))).toBe(255);
    expect(said.join("")).toMatch(/could not be run[^]*must each be an absolute path/);
  });

  // proves D-208 with rule 13: for an SSH address the real git runs the program named in GIT_SSH itself, with an argv
  // array (host, then the remote command) and the pinned paths in its environment, and nothing of the runner's own
  // environment. The recording program stands for `juno-anchor-ssh`; it refuses the connection, so the start fails closed
  it("makes the real git go through the pinned SSH program, with the pinned paths and no inherited environment", async () => {
    const record = join(dir, "ssh-call.json");
    const wrapper = join(dir, "record-ssh.mjs");
    writeFileSync(wrapper, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.exit(255);\n`);
    chmodSync(wrapper, 0o755);
    process.env["JUNO_TEST_LEAK"] = "must-not-reach-git";
    process.env["GIT_SSH_COMMAND"] = "/bin/false";
    try {
      const sink = new GitAnchorSink({ clone: join(dir, "clone"), pin: { url: "git@anchors.invalid:me/juno-anchors.git", branch: "main", transport: "ssh", knownHosts: "/etc/juno/anchors_known_hosts", pushKey: "/home/juno-runner/.ssh/juno_anchors", git: "/usr/bin/git" }, ssh: { wrapper, program: "/usr/bin/ssh" } });
      await expect(sink.listMany([])).rejects.toThrow(/pinned anchor repository could not be reached/);
    } finally {
      delete process.env["JUNO_TEST_LEAK"];
      delete process.env["GIT_SSH_COMMAND"];
    }
    const call = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(call.argv.at(-2)).toBe("git@anchors.invalid");
    expect(call.argv.at(-1)).toMatch(/^git-upload-pack '\/?me\/juno-anchors\.git'$/);
    expect(call.env[SSH_ENVIRONMENT.knownHosts]).toBe("/etc/juno/anchors_known_hosts");
    expect(call.env[SSH_ENVIRONMENT.pushKey]).toBe("/home/juno-runner/.ssh/juno_anchors");
    expect(call.env[SSH_ENVIRONMENT.program]).toBe("/usr/bin/ssh");
    expect(call.env["JUNO_TEST_LEAK"]).toBeUndefined();
    expect(call.env["GIT_SSH_COMMAND"]).toBeUndefined();
  });
});

describe("D-206 item 2: the anchor pin file", () => {
  const blob = (): string => {
    const der = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
    const raw = der.subarray(der.length - 32);
    const name = Buffer.from("ssh-ed25519");
    const length = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    return Buffer.concat([length(name.length), name, length(raw.length), raw]).toString("base64");
  };

  // proves D-208 with rule 13: the fingerprint JUNO computes for a host key is the one the real ssh-keygen prints, so
  // what the operator compares with GitHub's published fingerprint is what JUNO enforces
  it("computes the fingerprint the real ssh-keygen prints", async () => {
    const key = blob();
    const file = join(dir, "host.pub");
    writeFileSync(file, `github.com ssh-ed25519 ${key}\n`);
    const printed = await executeOutbound({ file: "/usr/bin/ssh-keygen", args: ["-l", "-E", "sha256", "-f", file] });
    expect(printed.exitCode, printed.stderr.toString("utf8")).toBe(0);
    expect(printed.stdout.toString("utf8").split(" ")[1]).toBe(sshFingerprint(key));
  });

  // proves D-208: the known-hosts file must say one thing only: the pinned key for the pinned host
  it("accepts exactly the pinned key for the pinned host, and refuses anything more", () => {
    const key = blob();
    const pinned = sshFingerprint(key);
    expect(knownHostsRefusals(`# GitHub\ngithub.com ssh-ed25519 ${key}\n`, "github.com", pinned)).toEqual([]);
    expect(knownHostsRefusals("", "github.com", pinned).join()).toMatch(/holds no host key/);
    expect(knownHostsRefusals(`github.com ssh-ed25519 ${blob()}\n`, "github.com", pinned).join()).toMatch(/not the pinned/);
    expect(knownHostsRefusals(`github.com ssh-ed25519 ${key}\ngithub.com ssh-ed25519 ${blob()}\n`, "github.com", pinned).join()).toMatch(/not the pinned/);
    expect(knownHostsRefusals(`@cert-authority github.com ssh-ed25519 ${key}\n`, "github.com", pinned).join()).toMatch(/markers such as @cert-authority are refused/);
    expect(knownHostsRefusals(`*.com ssh-ed25519 ${key}\n`, "github.com", pinned).join()).toMatch(/not exactly the pinned host/);
    expect(knownHostsRefusals(`github.com,evil.example ssh-ed25519 ${key}\n`, "github.com", pinned).join()).toMatch(/not exactly the pinned host/);
    expect(knownHostsRefusals(`|1|abc=|def= ssh-ed25519 ${key}\n`, "github.com", pinned).join()).toMatch(/not exactly the pinned host/);
  });

  // proves D-208: only an SSH address or an absolute local path is a pinned address; an SSH pin names its host key and push key
  it("reads a pin, and refuses one that names no host key for an SSH address", () => {
    expect(pinnedTransport("git@github.com:me/juno-anchors.git")).toEqual({ transport: "ssh", host: "github.com" });
    expect(pinnedTransport("ssh://git@github.com/me/juno-anchors.git")).toEqual({ transport: "ssh", host: "github.com" });
    expect(pinnedTransport("/srv/anchors.git")).toEqual({ transport: "local" });
    for (const url of ["https://github.com/me/juno-anchors.git", "git://github.com/me/x.git", "ext::sh -c x", "-oProxyCommand=x", "git@github.com:-x", "file:///srv/x", "relative/path"]) expect(pinnedTransport(url), url).toHaveProperty("refusal");
    const journals = [{ path: "/var/lib/juno-runner/journal", recovery_epoch: "2026-11-13T00:00:00Z" }];
    const ssh = { url: "git@github.com:me/juno-anchors.git", branch: "main", host_key_fingerprint: sshFingerprint(blob()), known_hosts: "/etc/juno/anchors_known_hosts", push_key: "/home/juno-runner/.ssh/juno_anchors", git: "/usr/bin/git", journals };
    expect(parseAnchorPin(JSON.stringify(ssh))).toMatchObject({ transport: "ssh", host: "github.com" });
    expect(() => parseAnchorPin(JSON.stringify({ ...ssh, host_key_fingerprint: null }))).toThrow(/needs host_key_fingerprint/);
    expect(() => parseAnchorPin(JSON.stringify({ ...ssh, journals: [] }))).toThrow();
    expect(() => parseAnchorPin(JSON.stringify({ ...ssh, journals: [{ path: "/j" }] }))).toThrow(/recovery_epoch/);
    expect(() => parseAnchorPin(JSON.stringify({ ...ssh, journals: [...journals, ...journals] }))).toThrow(/named once/);
    expect(() => parseAnchorPin(JSON.stringify({ ...ssh, extra: true }))).toThrow();
    expect(() => parseAnchorPin(JSON.stringify({ ...ssh, url: "/srv/anchors.git" }))).toThrow(/local path url has no host key/);
    expect(() => parseAnchorPin("not json")).toThrow(/not JSON/);
  });

  // proves D-208: the example the operator copies (docs/operator-setup.md, Part D step 7) is a pin once its three
  // placeholders are filled in, and is refused as it ships
  it("ships an example pin that needs only the operator's three values", () => {
    const example = readFileSync(new URL("../../../docs/examples/anchors.example.json", import.meta.url), "utf8");
    expect(() => parseAnchorPin(example)).toThrow();
    const filled = example.replace("<you>", "operator").replace(/<the ED25519 fingerprint[^>]*>/, sshFingerprint(blob())).replace(/<an early date[^>]*>/, "2020-01-01T00:00:00Z");
    expect(parseAnchorPin(filled)).toMatchObject({ transport: "ssh", host: "github.com", known_hosts: "/etc/juno/anchors_known_hosts", push_key: "/home/juno-runner/.ssh/juno_anchors", git: "/usr/bin/git" });
  });
});

/**
 * Review round 6 on PR #51, finding D1 (DECISIONS.md D-209): git speaks its protocol to `juno-anchor-ssh` over its
 * standard input and output, so the wrapper must carry them to ssh and back. Here the whole chain runs for real: the
 * real git, the real wrapper (its source run by this node), and a stand-in for ssh that checks it was given the pinned
 * options and then carries the git protocol to a local bare repository, as an SSH session to GitHub would. No network.
 */
describe("D-206 item 2 (D-209): the anchors travel over the pinned SSH transport, end to end", () => {
  let base: string;
  let wrapper: string;
  let remote: string;
  const key = generateKeyPairSync("ed25519");

  /** A stand-in ssh: refuses unless given the pinned options, then runs the remote git command on its own input and output. */
  function standInSsh(name: string, behaviour: "carry" | "hang"): string {
    const path = join(base, name);
    const log = join(base, `${name}.log`);
    writeFileSync(path, `#!${process.execPath}
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const option = (name) => argv.some((value, index) => argv[index - 1] === "-o" && value.startsWith(name + "="));
for (const needed of ["StrictHostKeyChecking=yes", "BatchMode=yes", "IdentitiesOnly=yes", "GlobalKnownHostsFile=/dev/null"]) if (!argv.includes(needed)) process.exit(250);
if (argv[0] !== "-F" || argv[1] !== "/dev/null" || !option("UserKnownHostsFile") || !option("IdentityFile")) process.exit(251);
// "hang": a server that never answers. Like ssh, it ends when its input closes (git has gone); otherwise never.
if (${JSON.stringify(behaviour)} === "hang") { process.stdin.on("data", () => undefined); process.stdin.on("end", () => process.exit(255)); setInterval(() => undefined, 1000); }
else {
  const match = /^(git-upload-pack|git-receive-pack) '(.*)'$/.exec(argv.at(-1) ?? "");
  if (match === null) process.exit(252);
  const child = execFile("/usr/bin/git", [match[1].slice(4), ${JSON.stringify(base)} + "/" + match[2].replace(/^\\//, "")], { encoding: "buffer", maxBuffer: 1 << 28 }, (error) => process.exit(error === null ? 0 : typeof error.code === "number" ? error.code : 253));
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
}
`);
    chmodSync(path, 0o755);
    return path;
  }

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "juno-anchor-ssh-e2e-"));
    // The real wrapper, run from its source by this node (type stripping): what `juno-anchor-ssh.js` is once built.
    wrapper = join(base, "juno-anchor-ssh");
    writeFileSync(wrapper, `#!${process.execPath}\nconst { main } = await import(${JSON.stringify(fileURLToPath(new URL("../src/anchor-ssh.ts", import.meta.url)))});\nprocess.exit(await main(process.argv.slice(2), process.env, (text) => process.stderr.write(text)));\n`);
    chmodSync(wrapper, 0o755);
    remote = join(base, "operator", "juno-anchors.git");
    mkdirSync(join(base, "operator"));
    const git = (args: readonly string[]) => executeOutbound({ file: "/usr/bin/git", args: ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args] });
    await git(["init", "--bare", "--quiet", remote]);
    const seed = join(base, "seed");
    await git(["clone", "--quiet", remote, seed]);
    writeFileSync(join(seed, "README.md"), "anchors\n");
    await git(["-C", seed, "add", "README.md"]);
    await git(["-C", seed, "commit", "--quiet", "-m", "start"]);
    expect((await git(["-C", seed, "push", "--quiet", "origin", "HEAD:main"])).exitCode).toBe(0);
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const sshPin = { url: "git@anchors.test:operator/juno-anchors.git", branch: "main", transport: "ssh" as const, knownHosts: "/etc/juno/anchors_known_hosts", pushKey: "/home/juno-runner/.ssh/juno_anchors", git: "/usr/bin/git" };

  // proves D-206 item 2 with §3.4.1: a service's start fetches, appends and lists through the pinned SSH transport
  // and the real wrapper; what it pushed is in the repository
  it("fetches, pushes and lists anchors through the real wrapper and an SSH transport", async () => {
    const ssh = standInSsh("ssh-carry", "carry");
    const started = Date.now();
    const sink = new GitAnchorSink({ clone: join(base, "clone"), pin: sshPin, ssh: { wrapper, program: ssh }, timeoutMs: 60_000 });
    expect(await sink.listMany([taskDigest("task-ssh")])).toEqual(new Map([[taskDigest("task-ssh"), []]]));
    await sink.append(anchorOf("task-ssh", { seq: 0, hash: `sha256:${"1".repeat(64)}` }, new Date(), key.privateKey));
    expect(((await new GitAnchorSink({ clone: join(base, "clone"), pin: sshPin, ssh: { wrapper, program: ssh } }).list(taskDigest("task-ssh"))) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([0]);
    expect(Date.now() - started).toBeLessThan(30_000);
    const reader = join(base, "reader");
    await executeOutbound({ file: "/usr/bin/git", args: ["clone", "--quiet", remote, reader] });
    expect((readAnchorDirectory(reader, taskDigest("task-ssh")) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([0]);
    // Every connection went through ssh with the pinned options, to the pinned host.
    const calls = readFileSync(join(base, "ssh-carry.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call.at(-2)).toBe("git@anchors.test");
  }, 60_000);

  // proves D-209 (fail-closed): a server that never answers refuses the start within the time limit, and leaves
  // nothing of its own behind; it does not hold the start for ever
  it("refuses, within its time limit, a server that never answers", async () => {
    const ssh = standInSsh("ssh-hang", "hang");
    const started = Date.now();
    const sink = new GitAnchorSink({ clone: join(base, "clone-hang"), pin: sshPin, ssh: { wrapper, program: ssh }, timeoutMs: 3_000 });
    await expect(sink.listMany([])).rejects.toThrow(/did not finish within 3 s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  // proves D-209: the wrapper itself carries what ssh writes back to git, and what git writes on to ssh
  it("carries the program's output to its own output, and its own input to the program", async () => {
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    // A program that ignores its arguments and copies its input to its output.
    const echo = join(base, "echo-input");
    writeFileSync(echo, `#!${process.execPath}\nprocess.stdin.pipe(process.stdout);\n`);
    chmodSync(echo, 0o755);
    const running = main([], { ...ENV, [SSH_ENVIRONMENT.program]: echo }, () => undefined, { stdin, stdout, stderr });
    stdin.end("hello through the wrapper\n");
    expect(await running).toBe(0);
    expect(out).toContain("hello through the wrapper");
  });
});


import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// D-219 (issue #56): the operator's runner terminal is a login shell, where Ubuntu's umask is 0002, so a build there made
// every file writable by its group, the runner image copied those modes, and `juno hook check` refused the image's own
// hook client (D-173: only root may change what the hook runs). JUNO's check was right; the build depended on the umask
// of whoever ran it. These tests prove the built code is writable by its owner only whatever that umask was: on the host
// (what Part E step 12's `make build` leaves in /opt/juno) and in the runner image, including an image built from
// group-writable files. CI runs them under umask 0022 (`verify`, `verify-rootless`) and 0002 (`verify-rootless-operator`).
// Every Docker call goes through execFile with an argv array; there is no shell.

const run = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));

/** Every entry under `dir`, symbolic links not followed, that its group or others may write. */
function groupOrOtherWritable(dir: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    const facts = lstatSync(path);
    if (facts.isSymbolicLink()) return;
    if ((facts.mode & 0o022) !== 0) found.push(`${path} ${(facts.mode & 0o7777).toString(8)}`);
    if (facts.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(dir);
  return found;
}

const findWritable = ["!", "-type", "l", "(", "-perm", "/022", "-o", "!", "-uid", "0", ")", "-print"];

const probe = { dir: "", image: "juno-code-modes-probe:local" };
afterAll(async () => {
  if (probe.dir !== "") rmSync(probe.dir, { recursive: true, force: true });
  await run("docker", ["image", "rm", "--force", probe.image]).catch(() => undefined);
});

describe("D-219: the built code is writable by its owner only, whatever the umask of whoever built it", () => {
  // proves D-219 (for D-173's rule that only root may change the hook client): `make build` and `make stage` leave
  // nothing their group or others may write, so a root build in /opt/juno (guide Part E step 12) passes `juno hook check`
  it("leaves dist/ and build/stage/ writable by their owner only", () => {
    expect(groupOrOtherWritable(join(root, "dist"))).toEqual([]);
    expect(groupOrOtherWritable(join(root, "build", "stage"))).toEqual([]);
    // Positive control: the walk does see the hook client, the executable and the dependencies.
    expect(lstatSync(join(root, "dist/mediated/src/juno-hook.js")).mode & 0o777).toBe(0o644);
    expect(lstatSync(join(root, "dist/journal/src/juno-anchor-ssh.js")).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(root, "build/stage/node_modules")).length).toBeGreaterThan(0);
  });

  // proves D-219 in the image `juno hook check` runs against (hook-separation.test.ts): everything under /app is root's
  // and writable by root alone
  it("gives the runner image's code to root alone", async () => {
    const { stdout } = await run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/find", "juno-runner:local", "/app", ...findWritable]);
    expect(stdout).toBe("");
    // Positive control: the same find names a file that matches.
    const control = await run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/find", "juno-runner:local", "/app/dist/mediated/src/juno-hook.js", "-uid", "0", "-perm", "0644", "-print"]);
    expect(control.stdout).toBe("/app/dist/mediated/src/juno-hook.js\n");
  });

  // proves D-219 does not rest on the host's build alone: the runner Dockerfile's own normalising step, applied to files
  // and folders its group may write (as a 0002 build makes them), leaves them root's and writable by root alone, keeps
  // an executable executable, and leaves a symbolic link alone
  it("takes group write off group-writable files in the image build itself", async () => {
    const dockerfile = readFileSync(join(root, "containers/runner.Dockerfile"), "utf8").split("\n");
    const from = dockerfile.find((line) => line.startsWith("FROM "));
    const normalise = dockerfile.find((line) => line.startsWith("RUN ") && line.includes('"-perm", "/022"'));
    expect(from).toBeDefined();
    expect(normalise).toBeDefined();
    probe.dir = mkdtempSync(join(tmpdir(), "juno-modes-"));
    const dist = join(probe.dir, "dist");
    mkdirSync(join(dist, "src"), { recursive: true });
    writeFileSync(join(dist, "src", "client.js"), "export {};\n");
    writeFileSync(join(dist, "src", "tool.js"), "export {};\n");
    chmodSync(join(dist, "src", "client.js"), 0o664);
    chmodSync(join(dist, "src", "tool.js"), 0o775);
    chmodSync(join(dist, "src"), 0o775);
    chmodSync(dist, 0o777);
    expect(groupOrOtherWritable(dist).length).toBe(4);
    writeFileSync(
      join(probe.dir, "Dockerfile"),
      [from, "WORKDIR /app", "COPY dist ./dist", 'RUN ["ln", "-s", "/tmp", "/app/link"]', normalise, ""].join("\n"),
    );
    await run("docker", ["build", "--quiet", "--network", "none", "--tag", probe.image, probe.dir], { timeout: 170_000 });
    const writable = await run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/find", probe.image, "/app", ...findWritable]);
    expect(writable.stdout).toBe("");
    const modes = await run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/stat", probe.image, "-c", "%a %u %n", "/app/dist", "/app/dist/src", "/app/dist/src/client.js", "/app/dist/src/tool.js"]);
    expect(modes.stdout).toBe("755 0 /app/dist\n755 0 /app/dist/src\n644 0 /app/dist/src/client.js\n755 0 /app/dist/src/tool.js\n");
    const link = await run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/readlink", probe.image, "/app/link"]);
    expect(link.stdout).toBe("/tmp\n");
  });
});

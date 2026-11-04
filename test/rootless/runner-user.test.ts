import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";

// D-130 (operator ruling (e) on D-129): in real use the runner runs as an unprivileged Linux user under a
// rootless container runtime, and /etc/wsl.conf turns WSL interop off. Only root can turn it back on, and
// nothing JUNO runs is root. These tests run AS the runner's user, under the rootless daemon, and prove
// what can be proven off the operator's machine (D-131):
// - the user is not root, holds no supplementary group, and cannot use sudo;
// - /etc/wsl.conf (on CI and in cloud sessions: the stand-in written by scripts/rootless/setup-root.sh)
//   disables interop and cannot be written, replaced or removed by this user;
// - the Docker daemon this user reaches is rootless, runs as this user, and the rootful daemon's socket is
//   out of reach (access to a rootful daemon is root, D-065, D-129 step 1);
// - the runtime can enforce the D-025 limits: cgroup v2 with the systemd driver (Docker's rootless docs:
//   "supported only when running with cgroup v2 and systemd"; otherwise the flags are silently ignored).
// Every program is started by execFile with an argv array (CLAUDE.md rule 8).

type Outcome = { readonly code: number | string; readonly stdout: string; readonly stderr: string };

function run(program: string, args: readonly string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = execFile(program, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
    // No input: a program asking for a password reads end-of-file and gives up at once.
    child.stdin?.end();
  });
}

// Groups that make a member root, or able to become root or read root's secrets, on Ubuntu and WSL
// distributions. The test below is stricter (no supplementary group at all); this list makes a failure
// message name the problem.
const ROOT_GRANTING_GROUPS = ["root", "sudo", "admin", "wheel", "docker", "lxd", "incus", "incus-admin", "libvirt", "disk", "shadow", "kvm", "adm"];

const WSL_CONF = "/etc/wsl.conf";

/** The [section] key=value pairs of an INI file, keys and sections lower-cased, values trimmed. */
function parseIni(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = (header[1] ?? "").trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values.set(`${section}.${line.slice(0, eq).trim().toLowerCase()}`, line.slice(eq + 1).trim().toLowerCase());
  }
  return values;
}

async function cannot(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "error";
  }
  return "succeeded";
}

function dockerHost(): string {
  const host = process.env["DOCKER_HOST"] ?? "";
  return host;
}

describe("the runner's user is unprivileged (D-130; §3.2 C1, §3.4.1 under WSL2)", () => {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  // proves D-130: nothing JUNO runs is root
  it("is not root", () => {
    expect(uid).not.toBe(0);
    expect(gid).not.toBe(0);
    expect(process.geteuid?.()).not.toBe(0);
  });

  // proves D-130, read restrictively by D-131: no membership in any group that grants root (none at all)
  it("holds no supplementary group, so none that grants root", async () => {
    const groups = await run("id", ["-Gn"]);
    expect(groups.code).toBe(0);
    const names = groups.stdout.trim().split(/\s+/);
    for (const name of ROOT_GRANTING_GROUPS) expect(names, `member of ${name}`).not.toContain(name);
    expect(process.getgroups?.()).toEqual([gid]);
  });

  // proves D-130: the runner's user cannot use sudo (absent, or refused without a password)
  it("cannot use sudo", async () => {
    const asRoot = await run("sudo", ["-n", "true"]);
    expect(asRoot.code).not.toBe(0);
    const listing = await run("sudo", ["-n", "-l"]);
    expect(listing.code).not.toBe(0);
  });

  // proves D-130: setuid helpers that could make this user root are not executable by it (su needs root's password)
  it("cannot become root through su without a password", async () => {
    const su = await run("su", ["-c", "true", "root"]);
    expect(su.code).not.toBe(0);
  });
});

describe("/etc/wsl.conf turns interop off and only root can change it (D-130)", () => {
  // proves D-130: interop is disabled and Windows paths are not appended (and D-131: drives are not automounted)
  it("disables interop, Windows paths and drive automount", async () => {
    const values = parseIni(await fs.readFile(WSL_CONF, "utf8"));
    expect(values.get("interop.enabled")).toBe("false");
    expect(values.get("interop.appendwindowspath")).toBe("false");
    expect(values.get("automount.enabled")).toBe("false");
  });

  // proves D-130: the file is root's, and neither its group nor others may write it
  it("is owned by root and writable by no one else", async () => {
    const stat = await fs.lstat(WSL_CONF);
    expect(stat.isFile()).toBe(true);
    expect(stat.uid).toBe(0);
    expect(stat.mode & 0o022).toBe(0);
    const etc = await fs.stat("/etc");
    expect(etc.uid).toBe(0);
    expect(etc.mode & 0o022).toBe(0);
  });

  // proves D-130: this user cannot write, truncate, replace or remove it
  it("cannot be written, replaced or removed by the runner's user", async () => {
    expect(await cannot(() => fs.access(WSL_CONF, constants.W_OK))).toBe("EACCES");
    expect(await cannot(() => fs.appendFile(WSL_CONF, "\n[interop]\nenabled=true\n"))).toBe("EACCES");
    expect(await cannot(() => fs.writeFile("/etc/wsl.conf.juno-probe", "x"))).toBe("EACCES");
    expect(await cannot(() => fs.rename(WSL_CONF, "/etc/wsl.conf.juno-moved"))).toBe("EACCES");
    expect(await cannot(() => fs.unlink(WSL_CONF))).toBe("EACCES");
    expect(await cannot(() => fs.access("/etc", constants.W_OK))).toBe("EACCES");
    const values = parseIni(await fs.readFile(WSL_CONF, "utf8"));
    expect(values.get("interop.enabled")).toBe("false");
  });

  // proves D-130: the session-only switch (/proc/sys/fs/binfmt_misc/WSLInterop) is root's too, where it exists
  it("cannot flip the session interop switch", async () => {
    const path = "/proc/sys/fs/binfmt_misc/WSLInterop";
    const present = await cannot(() => fs.access(path, constants.F_OK));
    if (present === "succeeded") expect(await cannot(() => fs.writeFile(path, "1"))).not.toBe("succeeded");
    else expect(present).toBe("ENOENT");
  });
});

describe("the container runtime is rootless and can enforce the D-025 limits (D-130)", () => {
  // proves D-130: the daemon is rootless, reached at this user's own socket
  it("talks to a rootless daemon on a socket this user owns", async () => {
    const host = dockerHost();
    expect(host).toMatch(/^unix:\/\//);
    const socket = host.slice("unix://".length);
    const stat = await fs.stat(socket);
    expect(stat.uid).toBe(process.getuid?.());
    const info = await run("docker", ["info", "--format", "{{json .SecurityOptions}}"]);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout) as string[]).toContain("name=rootless");
  });

  // proves D-130 (D-129 step 1): the rootful daemon's socket, which is root, is out of this user's reach
  it("cannot reach the rootful Docker socket", async () => {
    const result = await new Promise<string>((resolve) => {
      const socket = connect("/var/run/docker.sock");
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    expect(["EACCES", "ENOENT"]).toContain(result);
  });

  // proves D-130 with D-025: the rootless runtime enforces cgroup limits only on cgroup v2 with systemd; on
  // anything else it ignores --cpus, --memory and --pids-limit, so this must hold before any seal test counts
  it("runs on cgroup v2 with the systemd cgroup driver", async () => {
    const info = await run("docker", ["info", "--format", "{{.CgroupVersion}} {{.CgroupDriver}}"]);
    expect(info.code).toBe(0);
    expect(info.stdout.trim()).toBe("2 systemd");
  });

  // proves D-130 with D-025: the cpu, memory and pids controllers are delegated to this user's systemd manager
  it("has the cpu, memory and pids controllers delegated to this user", async () => {
    const uid = String(process.getuid?.());
    const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
    const controllers = (await fs.readFile(path, "utf8")).trim().split(/\s+/);
    for (const controller of ["cpu", "memory", "pids"]) expect(controllers).toContain(controller);
  });
});

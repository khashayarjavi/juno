import { execFile } from "node:child_process";

/**
 * How git reaches the pinned anchor repository over SSH (operator ruling D-206 item 2; DECISIONS.md D-208).
 *
 * Git is given this program as `GIT_SSH`; git runs `GIT_SSH` itself, with an argv array and no shell. The program runs
 * the real ssh with options that take every decision about the server's identity away from the runner's own settings:
 *   - `-F /dev/null`: neither the runner's `~/.ssh/config` nor the system's is read (so no alias, proxy command or
 *     other host key file can come from there);
 *   - `UserKnownHostsFile` is the root-owned pinned file and `GlobalKnownHostsFile` is empty: the only host key ssh
 *     accepts is the pinned one; `StrictHostKeyChecking=yes` refuses any other and never asks or learns;
 *   - `KnownHostsCommand=none`, `VerifyHostKeyDNS=no`, `UpdateHostKeys=no`, `CheckHostIP=no`: no other source of host
 *     keys, and the pinned file is never added to;
 *   - `IdentityFile` is the pinned push key and `IdentitiesOnly=yes`, `IdentityAgent=none`: no other key is offered;
 *   - `BatchMode=yes`: it never prompts.
 * The three paths come from the environment the anchor destination sets, taken from the verified anchor pin.
 */

export const SSH_ENVIRONMENT = { program: "JUNO_ANCHOR_SSH", knownHosts: "JUNO_ANCHOR_KNOWN_HOSTS", pushKey: "JUNO_ANCHOR_PUSH_KEY" } as const;

const absolute = (value: string | undefined): value is string => value !== undefined && value.startsWith("/") && !/[\0\n\r]/.test(value);

/** The ssh program and its argv for git's own arguments (`[-p port] [options] host command`), or why they cannot be built. */
export function sshInvocation(gitArgs: readonly string[], env: Readonly<Record<string, string | undefined>>): { readonly file: string; readonly args: readonly string[] } | { readonly refusal: string } {
  const program = env[SSH_ENVIRONMENT.program];
  const knownHosts = env[SSH_ENVIRONMENT.knownHosts];
  const pushKey = env[SSH_ENVIRONMENT.pushKey];
  if (!absolute(program) || !absolute(knownHosts) || !absolute(pushKey)) return { refusal: "juno-anchor-ssh: the pinned ssh program, known-hosts file and push key must each be an absolute path (D-208)" };
  // A path with a space, a quote, a `%` or a `~` would be read by ssh as more than a path.
  if ([knownHosts, pushKey].some((path) => /[\s"'%~\\]/.test(path))) return { refusal: "juno-anchor-ssh: the pinned known-hosts file and push key paths must not contain spaces, quotes, %, ~ or backslashes (D-208)" };
  return {
    file: program,
    args: [
      "-F", "/dev/null",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "KnownHostsCommand=none",
      "-o", "VerifyHostKeyDNS=no",
      "-o", "UpdateHostKeys=no",
      "-o", "CheckHostIP=no",
      "-o", "IdentitiesOnly=yes",
      "-o", "IdentityAgent=none",
      "-o", `IdentityFile=${pushKey}`,
      ...gitArgs,
    ],
  };
}

/** Runs ssh for git with the pinned options, on this process's own input and output. Answers ssh's exit code. */
export function main(gitArgs: readonly string[], env: Readonly<Record<string, string | undefined>>, err: (text: string) => void): Promise<number> {
  const invocation = sshInvocation(gitArgs, env);
  if ("refusal" in invocation) {
    err(`${invocation.refusal}\n`);
    return Promise.resolve(255);
  }
  return new Promise((resolve) => {
    const child = execFile(invocation.file, [...invocation.args], { shell: false, stdio: "inherit", maxBuffer: Infinity } as Parameters<typeof execFile>[2], (error) => {
      if (error === null) resolve(0);
      else if (typeof error.code === "number") resolve(error.code);
      else {
        err(`juno-anchor-ssh: ssh could not be run: ${error.message}\n`);
        resolve(255);
      }
    });
    void child;
  });
}

import { z } from "zod";
import { AbsolutePath, WORK_NAMESPACE, parseAtBoundary } from "../../contracts/src/index.js";
import type { Adapter, OutboundInvocation } from "./adapter.js";
import type { CapabilityCall } from "./call.js";
import { type WorkloadTarget, WorkloadTarget as WorkloadTargetSchema } from "./workload-adapter.js";

/**
 * `fs.file.write(path, content)` (spec §2.2.2, §2.4; build plan Slice 1.5 Increment 3 item 5; DECISIONS.md D-121, D-137).
 *
 * The adapter runs one fixed, operator-authored writer program in a fresh workload container (every setting
 * docker-compose.yml declares: no network, non-root, no capabilities, the D-025 limits, only work-vol). The path and the
 * content are two separate argv elements after `--` (a structural channel, §2.4). Content never goes through standard
 * input (§2.3.1: standard input carrying model-written content would have to be an instruction field).
 *
 * D-121, at the moment of the write: the writer walks the path from the root one component at a time, opening each
 * directory relative to the one before through `/proc/self/fd/<fd>/<name>` with `O_NOFOLLOW | O_DIRECTORY`, and opens
 * the file the same way with `O_NOFOLLOW`. So no symlink in any component is ever followed, whatever the boundary saw:
 * a component swapped for a symlink after the boundary's check fails the write, and the writer says why on standard
 * error with a non-zero exit, which the runner journals in the call's result.
 */

/** The writer's largest content, in bytes of UTF-8; anything longer is refused by the writer (D-137). */
export const MAX_WRITE_BYTES = 65536;

export const WRITER_SCRIPT = String.raw`
const fs = require("node:fs"); const C = fs.constants;
const [from, to, target, content] = process.argv.slice(1);
const refuse = (code, message) => { process.stderr.write("fs.file.write refused: " + message + "\n"); process.exit(code); };
if (typeof target !== "string" || typeof content !== "string") refuse(2, "expected a path and a content");
if (Buffer.byteLength(content, "utf8") > ${String(MAX_WRITE_BYTES)}) refuse(2, "the content is longer than ${String(MAX_WRITE_BYTES)} bytes");
if (!target.startsWith(from + "/")) refuse(2, "the path is not under " + from);
const parts = target.slice(from.length + 1).split("/");
if (parts.some((part) => part === "" || part === "." || part === "..")) refuse(2, "the path has an empty, . or .. component");
const DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
let dir; try { dir = fs.openSync(to, DIR); } catch (error) { refuse(3, "cannot open the root: " + error.code); }
for (const part of parts.slice(0, -1)) {
  const at = "/proc/self/fd/" + dir + "/" + part; let next;
  try { next = fs.openSync(at, DIR); } catch (error) {
    if (error.code === "ELOOP" || error.code === "ENOTDIR") refuse(5, "the path component " + JSON.stringify(part) + " is a symlink or not a directory (" + error.code + "); no symlink is followed");
    if (error.code !== "ENOENT") refuse(4, "cannot open " + JSON.stringify(part) + ": " + error.code);
    try { fs.mkdirSync(at, 0o755); next = fs.openSync(at, DIR); } catch (again) { refuse(5, "cannot create the directory " + JSON.stringify(part) + ": " + again.code); }
  }
  fs.closeSync(dir); dir = next;
}
const name = parts[parts.length - 1]; let fd;
try { fd = fs.openSync("/proc/self/fd/" + dir + "/" + name, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, 0o644); } catch (error) {
  if (error.code === "ELOOP") refuse(5, "the file " + JSON.stringify(name) + " is a symlink; no symlink is followed");
  refuse(4, "cannot open " + JSON.stringify(name) + ": " + error.code);
}
const bytes = Buffer.from(content, "utf8"); fs.writeSync(fd, bytes); fs.closeSync(fd);
process.stdout.write("wrote " + bytes.length + " bytes\n");
`;

/** The workload image's node, which runs the writer. It is in no capability's program enum. */
export const WRITER_NODE = "/nodejs/bin/node";

export const FS_WRITE = "workload.fs_write";

const WriteCall = z.strictObject({ path: AbsolutePath, content: z.string() });

/** The writer's arguments after its program: the script, `--`, the view roots, then the path and the content. */
export function writerArgs(from: string, to: string, path: string, content: string): string[] {
  return ["-e", WRITER_SCRIPT, "--", from, to, path, content];
}

/** The `fs.file.write` adapter: the writer in a fresh workload container. */
export class WorkloadWriteAdapter implements Adapter {
  readonly id = FS_WRITE;
  readonly #target: WorkloadTarget;

  constructor(target: WorkloadTarget) {
    this.#target = parseAtBoundary("workload target", WorkloadTargetSchema, target);
  }

  plan(call: CapabilityCall): OutboundInvocation {
    const { path, content } = parseAtBoundary("fs.file.write call", WriteCall, call);
    const { composeFile, project, service } = this.#target;
    return {
      file: "docker",
      args: ["compose", "-f", composeFile, "-p", project, "run", "--rm", "--no-deps", "-T", "--entrypoint", WRITER_NODE, service, ...writerArgs(WORK_NAMESPACE, WORK_NAMESPACE, path, content)],
    };
  }
}

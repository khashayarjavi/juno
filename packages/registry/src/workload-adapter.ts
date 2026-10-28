import { z } from "zod";
import { AbsolutePath, parseAtBoundary } from "../../contracts/src/index.js";
import type { Adapter, OutboundInvocation } from "./adapter.js";
import type { CapabilityCall } from "./call.js";

/**
 * The `shell.run` adapter (spec §2.4, §18): runs the program in a fresh
 * workload container through `docker compose run`, so the container gets
 * every setting docker-compose.yml declares (no network, non-root, no
 * capabilities, the D-025 limits, only work-vol). Each `data` value is one
 * discrete element of the argv array: `cwd` is the value of `--workdir`,
 * and each `argv` element follows the service name, where compose passes it
 * to the program unparsed. The program is the container's entrypoint, so the
 * image's default command is never appended (DECISIONS.md D-034).
 */

export const WORKLOAD_EXECFILE = "workload.execfile";

export const WorkloadTarget = z.strictObject({
  composeFile: AbsolutePath,
  /** A compose project name (lower-case letters, digits, `-` and `_`). */
  project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  service: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
});
export type WorkloadTarget = z.infer<typeof WorkloadTarget>;

const ShellRunCall = z.strictObject({
  program: AbsolutePath,
  argv: z.array(z.string()),
  cwd: AbsolutePath,
});

export class WorkloadExecFileAdapter implements Adapter {
  readonly id = WORKLOAD_EXECFILE;
  readonly #target: WorkloadTarget;

  constructor(target: WorkloadTarget) {
    this.#target = parseAtBoundary("workload target", WorkloadTarget, target);
  }

  plan(call: CapabilityCall): OutboundInvocation {
    const { program, argv, cwd } = parseAtBoundary("shell.run call", ShellRunCall, call);
    const { composeFile, project, service } = this.#target;
    return {
      file: "docker",
      args: [
        "compose", "-f", composeFile, "-p", project,
        "run", "--rm", "--no-deps", "-T",
        "--workdir", cwd,
        "--entrypoint", program,
        service,
        ...argv,
      ],
    };
  }
}

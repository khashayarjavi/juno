import { z } from "zod";
import { executeOutbound } from "../../registry/src/index.js";

/**
 * The container runtime must enforce the workload's limits (DECISIONS.md D-025, D-130, D-131, D-149).
 *
 * Docker's rootless mode silently ignores `--cpus`, `--memory` and `--pids-limit` unless it runs on cgroup v2 with
 * systemd; it then reports cgroup driver `none` (Docker's rootless docs, read 2026-11-04). A runner that started
 * workloads there would run them without the D-025 limits while believing they held. So a runner refuses to start on
 * such a runtime.
 */

export type ContainerRuntime = { readonly cgroupDriver: string; readonly cgroupVersion: string; readonly rootless: boolean };

/** Why this runtime cannot be trusted to enforce the workload's limits, or null when it can. */
export function runtimeRefusal(runtime: ContainerRuntime): string | null {
  if (runtime.cgroupDriver === "none" || runtime.cgroupDriver === "") {
    return `the container runtime reports cgroup driver "${runtime.cgroupDriver}", so it would ignore the workload's CPU, memory and process limits (D-025, D-131)`;
  }
  if (runtime.cgroupVersion !== "1" && runtime.cgroupVersion !== "2") return `the container runtime reports cgroup version "${runtime.cgroupVersion}"`;
  if (runtime.rootless && (runtime.cgroupVersion !== "2" || runtime.cgroupDriver !== "systemd")) {
    return "a rootless runtime enforces limits only on cgroup v2 with the systemd driver (D-131)";
  }
  return null;
}

const DockerInfo = z.object({ CgroupDriver: z.string(), CgroupVersion: z.string(), SecurityOptions: z.array(z.string()).nullable().optional() });

/** Asks the Docker daemon the runner would use (`docker info`, by execFile with an argv array). */
export async function probeContainerRuntime(): Promise<ContainerRuntime> {
  const result = await executeOutbound({ file: "docker", args: ["info", "--format", "{{json .}}"] });
  if (result.exitCode !== 0) throw new Error(`docker info failed: ${result.stderr.toString("utf8").trim()}`);
  const info = DockerInfo.parse(JSON.parse(result.stdout.toString("utf8")));
  return { cgroupDriver: info.CgroupDriver, cgroupVersion: info.CgroupVersion, rootless: (info.SecurityOptions ?? []).includes("name=rootless") };
}

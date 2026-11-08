import { describe, expect, it } from "vitest";
import { runtimeRefusal } from "../src/runtime.js";

// D-025, D-131, D-149: a runtime that would silently ignore the workload's CPU, memory and process limits is refused.
describe("the container runtime must enforce the workload's limits (D-131, D-149)", () => {
  // proves D-131's Increment 4 directive: cgroup driver "none" (rootless without cgroup v2 and systemd) is refused
  it("refuses cgroup driver none, and a rootless runtime without cgroup v2 and systemd", () => {
    expect(runtimeRefusal({ cgroupDriver: "none", cgroupVersion: "1", rootless: true })).toMatch(/ignore the workload's CPU, memory and process limits/);
    expect(runtimeRefusal({ cgroupDriver: "cgroupfs", cgroupVersion: "2", rootless: true })).toMatch(/systemd/);
    expect(runtimeRefusal({ cgroupDriver: "systemd", cgroupVersion: "", rootless: false })).not.toBeNull();
  });

  // proves D-149: the runtimes the limit tests pass on are accepted (rootful cgroupfs or systemd; rootless on v2 with systemd)
  it("accepts runtimes that enforce the limits", () => {
    expect(runtimeRefusal({ cgroupDriver: "cgroupfs", cgroupVersion: "1", rootless: false })).toBeNull();
    expect(runtimeRefusal({ cgroupDriver: "systemd", cgroupVersion: "2", rootless: false })).toBeNull();
    expect(runtimeRefusal({ cgroupDriver: "systemd", cgroupVersion: "2", rootless: true })).toBeNull();
  });
});

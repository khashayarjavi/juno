import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Adapter,
  CANARY_PAYLOAD,
  CapabilityRegistry,
  FS_WRITE,
  MAX_WRITE_BYTES,
  WorkloadWriteAdapter,
  executeOutbound,
  loadRegistryEntry,
  runConformanceSuite,
  writerArgs,
} from "../src/index.js";

const DEFINITION = fileURLToPath(new URL("../definitions/fs.file.write.json", import.meta.url));
const target = { composeFile: "/repo/containers/docker-compose.yml", project: "juno-test", service: "workload" };

describe("fs.file.write registration (§2.2.2, §2.4; D-137)", () => {
  // proves §2.2.2 build plan item 1: the path is a target and the content a payload; it is a write
  it("declares its path a target, its content a payload, and its effect write", () => {
    const { capability } = loadRegistryEntry(DEFINITION);
    expect(capability.side_effect).toBe("write");
    expect(capability.interface["path"]).toMatchObject({ role: "data", data_effect: "target", type: { kind: "path" } });
    expect(capability.interface["content"]).toMatchObject({ role: "data", data_effect: "payload", type: { kind: "string" } });
  });

  // proves §2.4: the canary (shell metacharacters, quotes, a newline) arrives as one intact argv element, and it registers
  it("delivers each canary as one intact argv element, and registers", () => {
    const { capability } = loadRegistryEntry(DEFINITION);
    const result = runConformanceSuite(capability, new WorkloadWriteAdapter(target), "fixedtag");
    expect(result).toMatchObject({ conforming: true, canaries: 2 });
    if (!result.conforming) return;
    expect(result.invocation.args).toContain("juno-canary-fixedtag-1" + CANARY_PAYLOAD);
    expect(new CapabilityRegistry().register(loadRegistryEntry(DEFINITION), [new WorkloadWriteAdapter(target)])).toEqual({ registered: true, id: "fs.file.write" });
  });

  // proves §2.4: an adapter that interpolates the path or content into a parsed string is blocked at registration
  it("refuses an interpolating variant at registration", () => {
    const interpolating: Adapter = {
      id: FS_WRITE,
      plan: (call) => ({ file: "docker", args: ["compose", "run", "workload", "sh", "-c", `printf %s '${String(call["content"])}' > ${String(call["path"])}`] }),
    };
    const result = new CapabilityRegistry().register(loadRegistryEntry(DEFINITION), [interpolating]);
    expect(result).toMatchObject({ registered: false, refusals: [{ kind: "nonconforming_adapter", adapter: FS_WRITE }] });
  });

  // proves D-134: a typed entry may not carry an instruction field, so nothing in a call can choose what runs
  it("refuses a typed entry that has an instruction field", () => {
    const entry = loadRegistryEntry(DEFINITION);
    const withInstruction = { ...entry, capability: { ...entry.capability, interface: { ...entry.capability.interface, mode: { type: { kind: "string" } } } } };
    expect(new CapabilityRegistry().register(withInstruction, [new WorkloadWriteAdapter(target)])).toMatchObject({ registered: false, refusals: [{ kind: "invalid_definition" }] });
  });
});

describe("the writer refuses to follow a symlink in any path component (D-121, D-137)", () => {
  let dir: string;
  let work: string;
  const write = (path: string, content: string) => executeOutbound({ file: process.execPath, args: writerArgs("/work", work, path, content) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "juno-writer-"));
    work = join(dir, "work");
    mkdirSync(join(work, "project"), { recursive: true });
    mkdirSync(join(dir, "outside"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // proves build plan item 5: the writer writes the content to the path, creating missing directories
  it("writes the content, creating missing directories", async () => {
    const result = await write("/work/project/new/dir/out.txt", "hello\n");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(work, "project", "new", "dir", "out.txt"), "utf8")).toBe("hello\n");
  });

  // proves D-121: a directory component that is a symlink is not followed, and nothing outside changes
  it("refuses a symlink in a directory component", async () => {
    symlinkSync(join(dir, "outside"), join(work, "project", "sub"));
    const result = await write("/work/project/sub/out.txt", "escaped\n");
    expect(result.exitCode).toBe(5);
    expect(result.stderr.toString("utf8")).toMatch(/"sub" is a symlink or not a directory .*no symlink is followed/);
    expect(existsSync(join(dir, "outside", "out.txt"))).toBe(false);
  });

  // proves D-121: a final component that is a symlink is not followed; its target is unchanged
  it("refuses a symlink as the file itself", async () => {
    writeFileSync(join(dir, "outside", "victim.txt"), "unchanged\n");
    symlinkSync(join(dir, "outside", "victim.txt"), join(work, "project", "out.txt"));
    const result = await write("/work/project/out.txt", "overwritten\n");
    expect(result.exitCode).toBe(5);
    expect(readFileSync(join(dir, "outside", "victim.txt"), "utf8")).toBe("unchanged\n");
    expect(lstatSync(join(work, "project", "out.txt")).isSymbolicLink()).toBe(true);
  });

  // proves D-137: the content bound and the path shape are the writer's own checks
  it("refuses content over the bound, and a path with .. or outside the view", async () => {
    expect((await write("/work/project/big.txt", "x".repeat(MAX_WRITE_BYTES + 1))).exitCode).toBe(2);
    expect((await write("/work/project/../x.txt", "x")).exitCode).toBe(2);
    expect((await write("/etc/x.txt", "x")).exitCode).toBe(2);
    expect(existsSync(join(work, "project", "big.txt"))).toBe(false);
  });
});

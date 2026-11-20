import process from "node:process";
import { type SealedLauncher, runProgram, sealedProgram } from "../src/index.js";

/**
 * Tests only (D-228): the sealed program, run by this process's own node on the host, without the container. It is the
 * very text the sealed context runs, so the unit tests judge its logic; the seal itself (no capabilities, no network,
 * one mount, nothing of the runner's reachable) is proven against the real runtime by test/containers/sealed-copy.test.ts.
 */
export const unsealedLauncher: SealedLauncher = (request) =>
  runProgram(process.execPath, ["--input-type=module", "-e", sealedProgram(), "--", request.op, request.workspace, request.root, request.dev, request.ino], request.input);

// D-241 ruling 1 (D-242), run in one sealed container from the runner image (no network, no capabilities, read-only
// root, see casefold-superblock.test.ts). It makes real ext4 file systems with the image's own e2fsprogs: one with the
// casefold feature, one without, and one made without it and then given it by root with tune2fs, as only root can.
// dumpe2fs reads each one's features; JUNO's own superblock reader and the refusals `juno hook check` runs judge each.
// This kernel cannot mount an ext4 that folds case (no CONFIG_UNICODE), and a sealed container may not mount at all, so
// the one stand-in is which block device holds the workspace: the file system's bytes are the image's. No shell.
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const exit = async (program, args) => {
  try {
    const { stdout, stderr } = await run(program, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message) };
  }
};

const IMAGES = { casefold: "/scratch/casefold.img", plain: "/scratch/plain.img", later: "/scratch/later.img" };
const results = { made: {}, features: {}, read: {}, refusals: {} };
results.made.casefold = await exit("mkfs.ext4", ["-q", "-F", "-O", "casefold", IMAGES.casefold, "8M"]);
results.made.plain = await exit("mkfs.ext4", ["-q", "-F", IMAGES.plain, "8M"]);
results.made.later = await exit("mkfs.ext4", ["-q", "-F", IMAGES.later, "8M"]);
results.made.laterTune = await exit("tune2fs", ["-O", "casefold", IMAGES.later]);

const { ext4CaseFolding, superblockRefusals, systemSuperblockIo } = await import("/app/dist/mediated/src/superblock.js");
const system = systemSuperblockIo();
for (const [name, image] of Object.entries(IMAGES)) {
  const dump = await exit("dumpe2fs", ["-h", image]);
  results.features[name] = dump.stdout.split("\n").find((line) => line.startsWith("Filesystem features:")) ?? null;
  const read = system.readSuperblock(image);
  results.read[name] = read.ok ? { ok: true, blockDevice: read.blockDevice, folding: ext4CaseFolding(read.bytes) } : read;
  // The workspace's mount, as /proc/self/mountinfo shows an ext4 on a loop device; its superblock is the image's,
  // read by the real reader, and reported as that loop device.
  const io = {
    ...system,
    mountinfo: () => "25 1 7:0 / /srv/juno-work rw,relatime - ext4 /dev/loop0 rw",
    realpath: (path) => path,
    deviceOf: () => ({ major: 7, minor: 0 }),
    deviceName: () => "loop0",
    readSuperblock: (node) => {
      const real = system.readSuperblock(image);
      return node === "/dev/loop0" && real.ok ? { ...real, blockDevice: { major: 7, minor: 0 } } : { ok: false, error: `unexpected device ${node}` };
    },
  };
  results.refusals[name] = superblockRefusals([{ what: "the workspace", path: "/srv/juno-work" }], io);
}
// The real system, unchanged: the container's scratch tmpfs passes; a regular file is never taken for a block device.
results.realTmpfs = superblockRefusals([{ what: "the workspace", path: "/scratch" }], system);
process.stdout.write(JSON.stringify(results));

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CASE_SENSITIVE_TYPES, type Mount, mountOf, parseMountinfo } from "./filesystem.js";
import { asRootCommand, commandText, shownName } from "../../journal/src/index.js";

/**
 * Case folding switched off for the whole file system, read from its superblock (operator ruling 1 of 2026-11-21 on
 * D-240; DECISIONS.md D-241, D-242). D-178's checks and D-238 to D-240's per-write checks detect a folder that folds
 * case. This one makes such a folder impossible on a verified install: ext4 folds case only in a file system made, or
 * changed by root with `tune2fs`, to carry the `casefold` feature, and without it no folder there can be given the
 * attribute (`chattr +F` is refused). The Claude Code user cannot switch the feature on; that needs root. So
 * `juno hook check`, run as root, reads the superblock of every file system holding a workspace or a source, or mounted
 * inside one, and refuses unless:
 *   - it is ext4, read from its own block device (`/dev/<name>` of the mount's device number, which must be that block
 *     device, checked again on the open file), and its superblock is ext4's (magic 0xEF53) with the `casefold` feature
 *     bit (s_feature_incompat 0x20000) clear and no character encoding (s_encoding) set; or
 *   - it is a tmpfs, whose superblock is in memory and whose case folding is a superblock option (`casefold`) the
 *     kernel reports in /proc/self/mountinfo; D-178's check refuses that option (autopilot ruling D-242: tmpfs keeps
 *     being accepted, since its superblock options are read there).
 * Any other type is refused here: btrfs is a case-sensitive type D-178 accepts, but no ext4 or tmpfs superblock can
 * confirm it (D-242, restrictive). Types D-178 refuses (drvfs, 9p, overlay, …) are refused there, with its reason.
 * D-240's per-write check stays as a second layer (ruling 1).
 */

/** ext4's superblock: 1024 bytes, 1024 bytes into the device (fs/ext4/ext4.h, `struct ext4_super_block`). */
export const SUPERBLOCK_OFFSET = 1024;
export const SUPERBLOCK_SIZE = 1024;
const MAGIC_AT = 0x38;
const MAGIC = 0xef53;
const INCOMPAT_AT = 0x60;
/** EXT4_FEATURE_INCOMPAT_CASEFOLD. */
export const INCOMPAT_CASEFOLD = 0x20000;
const ENCODING_AT = 0x27c;

export type Ext4CaseFolding = { readonly ok: true; readonly casefold: boolean; readonly encoding: number } | { readonly ok: false; readonly error: string };

/** What an ext4 superblock says about case folding; an error when the bytes are not an ext4 superblock. */
export function ext4CaseFolding(bytes: Uint8Array): Ext4CaseFolding {
  if (bytes.length < SUPERBLOCK_SIZE) return { ok: false, error: `only ${String(bytes.length)} of its ${String(SUPERBLOCK_SIZE)} bytes could be read` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(MAGIC_AT, true) !== MAGIC) return { ok: false, error: "it does not hold ext4's superblock (no 0xEF53 magic number)" };
  const incompat = view.getUint32(INCOMPAT_AT, true);
  return { ok: true, casefold: (incompat & INCOMPAT_CASEFOLD) !== 0, encoding: view.getUint16(ENCODING_AT, true) };
}

export type DeviceNumber = { readonly major: number; readonly minor: number };

export type SuperblockRead = { readonly ok: true; readonly bytes: Uint8Array; readonly blockDevice: DeviceNumber | null } | { readonly ok: false; readonly error: string };

export type SuperblockIo = {
  /** The text of /proc/self/mountinfo, or null when it cannot be read. */
  readonly mountinfo: () => string | null;
  /** The kernel's realpath(3) of `path`, or null when it does not resolve. */
  readonly realpath: (path: string) => string | null;
  /** The device number of the file system `path` (already resolved) lies on, or null. */
  readonly deviceOf: (path: string) => DeviceNumber | null;
  /** `DEVNAME` of /sys/dev/block/<major>:<minor>/uevent, or null. */
  readonly deviceName: (device: DeviceNumber) => string | null;
  /** The superblock's bytes at `path`, and, read from the open file, the block device it is (null when it is none). */
  readonly readSuperblock: (path: string) => SuperblockRead;
};

/** Linux's dev_t split (glibc's gnu_dev_major and gnu_dev_minor, whose high parts are cast to 32 bits). */
export function splitDevice(dev: bigint): DeviceNumber {
  return { major: Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)), minor: Number((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)) };
}

const parseDevice = (text: string | undefined): DeviceNumber | null => {
  const match = /^(\d+):(\d+)$/.exec(text ?? "");
  return match === null ? null : { major: Number(match[1]), minor: Number(match[2]) };
};

const same = (a: DeviceNumber, b: DeviceNumber): boolean => a.major === b.major && a.minor === b.minor;
const named = (device: DeviceNumber): string => `${String(device.major)}:${String(device.minor)}`;
const within = (path: string, prefix: string): boolean => prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);

/** A device name sysfs may give: path parts of safe characters, never `.` or `..`. */
const DEVICE_NAME = /^[A-Za-z0-9_+:-][A-Za-z0-9._+:-]*(\/[A-Za-z0-9_+:-][A-Za-z0-9._+:-]*)*$/;

/** The mount entries of /proc/self/mountinfo with each one's device number (field 3), in order; null when unreadable. */
function mountsWithDevices(text: string): (Mount & { readonly device: DeviceNumber | null })[] | null {
  const mounts = parseMountinfo(text);
  if (mounts === null) return null;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return mounts.map((mount, index) => ({ ...mount, device: parseDevice(lines[index]?.split(" ")[2]) }));
}

/**
 * The refusals for these paths (workspace roots and sources, as host paths): empty when every file system holding one,
 * or mounted inside one, is confirmed to have case folding switched off (D-242). `what` names each path's role.
 */
export function superblockRefusals(paths: readonly { readonly what: string; readonly path: string }[], io: SuperblockIo, rerun?: readonly string[]): string[] {
  const text = io.mountinfo();
  const mounts = text === null ? null : mountsWithDevices(text);
  if (mounts === null) return ["JUNO cannot read /proc/self/mountinfo, so it cannot tell which file system holds the workspace or read its superblock (D-242)"];
  const refusals: string[] = [];
  const judged = new Set<string>();
  for (const { what, path } of paths) {
    if (!path.startsWith("/")) continue; // D-178's check refuses it, with its reason.
    // A path that does not exist yet is judged by its nearest existing ancestor, where it will be created.
    let at = path;
    let real = io.realpath(at);
    while (real === null && at !== "/") {
      at = dirname(at);
      real = io.realpath(at);
    }
    if (real === null) continue; // D-178's check refuses it.
    const own = mountOf(real, mounts as readonly Mount[]) as ((typeof mounts)[number] | null);
    if (own === null) continue; // D-178's check refuses it.
    const inside = mounts.filter((mount) => mount !== own && mount.mountPoint !== real && within(mount.mountPoint, real));
    for (const [mount, where, role] of [[own, real, what] as const, ...inside.map((mount) => [mount, mount.mountPoint, `a mount inside ${what}`] as const)]) {
      const key = `${where}\n${shownName(mount.mountPoint)}`;
      if (judged.has(key)) continue;
      judged.add(key);
      const refusal = judgeMount(role, role === what ? path : where, where, mount, io, rerun);
      if (refusal !== null) refusals.push(refusal);
    }
  }
  return refusals;
}

function judgeMount(what: string, path: string, where: string, mount: Mount & { readonly device: DeviceNumber | null }, io: SuperblockIo, rerun?: readonly string[]): string | null {
  if (mount.fsType === "tmpfs") return null; // Its case folding is a superblock option mountinfo shows; D-178 judges it.
  if (mount.fsType !== "ext4") {
    if (!CASE_SENSITIVE_TYPES.has(mount.fsType)) return null; // D-178 refuses this type, with its reason.
    return `${what} ${shownName(path)} is on a ${mount.fsType} file system (mounted at ${shownName(mount.mountPoint)}); juno hook check can confirm that case folding is switched off for a whole file system only on ext4, read from its superblock, or on a tmpfs, from its mount options; put the workspace on the distribution's own ext4 file system, as the guide does (D-242)`;
  }
  const device = mount.device;
  const actual = io.deviceOf(where);
  if (device === null || actual === null || !same(device, actual)) {
    return `JUNO cannot tell which device holds the ext4 file system of ${what} ${shownName(path)} (mounted at ${shownName(mount.mountPoint)}), so it cannot read its superblock to confirm that case folding is switched off (D-242)`;
  }
  const name = io.deviceName(device);
  if (name === null || !DEVICE_NAME.test(name)) {
    return `JUNO cannot find the block device ${named(device)} that holds ${what} ${shownName(path)} (mounted at ${shownName(mount.mountPoint)}), so it cannot read its superblock to confirm that case folding is switched off (D-242)`;
  }
  const node = `/dev/${name}`;
  const read = io.readSuperblock(node);
  if (!read.ok) {
    return `JUNO cannot read the superblock of ${node}, the ext4 file system holding ${what} ${shownName(path)} (${read.error}), so it cannot confirm that case folding is switched off; run juno hook check as root, with sudo${rerun === undefined ? "" : `: ${commandText(asRootCommand(rerun))}`} (D-242)`;
  }
  if (read.blockDevice === null || !same(read.blockDevice, device)) {
    return `${node} is not the block device ${named(device)} that holds ${what} ${shownName(path)}, so JUNO cannot read that file system's superblock to confirm that case folding is switched off (D-242)`;
  }
  const answer = ext4CaseFolding(read.bytes);
  if (!answer.ok) return `the superblock of ${node}, holding ${what} ${shownName(path)}, cannot be read as ext4's: ${answer.error}; JUNO cannot confirm that case folding is switched off (D-242)`;
  if (answer.casefold || answer.encoding !== 0) {
    return `${what} ${shownName(path)} is on an ext4 file system (${node}, mounted at ${shownName(mount.mountPoint)}) with ext4's case-folding feature switched on (${answer.casefold ? "casefold" : "a character encoding"} in its superblock), so a folder there can be made to ignore letter case; JUNO accepts only a file system made without that feature (dumpe2fs -h ${node} must not list casefold) (D-242)`;
  }
  return null;
}

/** The real system: /proc/self/mountinfo, stat, sysfs, and the block device opened read-only, never following a link. */
export function systemSuperblockIo(): SuperblockIo {
  return {
    mountinfo: () => {
      try {
        return readFileSync("/proc/self/mountinfo", "utf8");
      } catch {
        return null;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync.native(path);
      } catch {
        return null;
      }
    },
    deviceOf: (path) => {
      try {
        return splitDevice(statSync(path, { bigint: true }).dev);
      } catch {
        return null;
      }
    },
    deviceName: (device) => {
      try {
        const uevent = readFileSync(`/sys/dev/block/${named(device)}/uevent`, "utf8");
        const line = uevent.split("\n").find((row) => row.startsWith("DEVNAME="));
        return line === undefined ? null : line.slice("DEVNAME=".length);
      } catch {
        return null;
      }
    },
    readSuperblock: (path) => {
      let fd: number;
      try {
        if (lstatSync(path).isSymbolicLink()) return { ok: false, error: `${shownName(path)} is a symbolic link` };
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        const stats = fstatSync(fd, { bigint: true });
        const bytes = new Uint8Array(SUPERBLOCK_SIZE);
        let got = 0;
        while (got < SUPERBLOCK_SIZE) {
          const n = readSync(fd, bytes, got, SUPERBLOCK_SIZE - got, SUPERBLOCK_OFFSET + got);
          if (n === 0) break;
          got += n;
        }
        return { ok: true, bytes: bytes.subarray(0, got), blockDevice: stats.isBlockDevice() ? splitDevice(stats.rdev) : null };
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        closeSync(fd);
      }
    },
  };
}

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INCOMPAT_CASEFOLD, SUPERBLOCK_OFFSET, SUPERBLOCK_SIZE, type SuperblockIo, ext4CaseFolding, splitDevice, superblockRefusals, systemSuperblockIo } from "../src/superblock.js";

// D-241 ruling 1 (D-242): `juno hook check`, run as root, confirms that case folding is switched off for the whole file
// system holding the workspace, read from its ext4 superblock, and refuses otherwise in plain words. These tests judge
// the reader and the refusals with a stand-in for the system; test/containers/casefold-superblock.test.ts reads real
// ext4 file systems made by mkfs.ext4 with and without the casefold feature.

/** An ext4 superblock's 1024 bytes: magic 0xEF53 at 0x38, s_feature_incompat at 0x60, s_encoding at 0x27C. */
function superblock(options: { casefold?: boolean; encoding?: number; magic?: number; incompat?: number } = {}): Uint8Array {
  const bytes = new Uint8Array(SUPERBLOCK_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint16(0x38, options.magic ?? 0xef53, true);
  // mkfs.ext4 1.47's default incompat set (filetype, extent, 64bit, flex_bg), as dumpe2fs reads it, plus casefold.
  view.setUint32(0x60, (options.incompat ?? 0x2c2) | (options.casefold === true ? INCOMPAT_CASEFOLD : 0), true);
  view.setUint16(0x27c, options.encoding ?? (options.casefold === true ? 1 : 0), true);
  return bytes;
}

const SDC = { major: 8, minor: 32 };
const MOUNTINFO = ["25 1 8:32 / / rw,relatime - ext4 /dev/sdc rw,discard,errors=remount-ro", "40 25 0:40 / /tmp rw - tmpfs tmpfs rw"].join("\n");

function fakeIo(overrides: Partial<Omit<SuperblockIo, "mountinfo">> & { bytes?: Uint8Array; mountinfo?: string | null } = {}): SuperblockIo {
  const { bytes, mountinfo, ...rest } = overrides;
  return {
    mountinfo: () => (mountinfo === undefined ? MOUNTINFO : mountinfo),
    realpath: (path) => path,
    deviceOf: (path) => (path === "/tmp" || path.startsWith("/tmp/") ? { major: 0, minor: 40 } : path.startsWith("/srv/juno-work/inner") ? { major: 8, minor: 48 } : SDC),
    deviceName: (device) => (device.major === 8 && device.minor === 32 ? "sdc" : device.major === 8 && device.minor === 48 ? "sdd" : null),
    readSuperblock: (path) => (path === "/dev/sdc" ? { ok: true, bytes: bytes ?? superblock(), blockDevice: SDC } : path === "/dev/sdd" ? { ok: true, bytes: superblock({ casefold: true }), blockDevice: { major: 8, minor: 48 } } : { ok: false, error: "ENOENT" }),
    ...rest,
  };
}

const WORKSPACE = [{ what: "the workspace", path: "/srv/juno-work" }];

describe("D-242: case folding switched off for the whole file system, read from its superblock (D-241 ruling 1)", () => {
  // proves D-241 ruling 1: the casefold feature bit and the encoding field are read where ext4 keeps them
  it("reads ext4's casefold feature and encoding from the superblock's bytes", () => {
    expect(ext4CaseFolding(superblock())).toEqual({ ok: true, casefold: false, encoding: 0 });
    expect(ext4CaseFolding(superblock({ casefold: true }))).toEqual({ ok: true, casefold: true, encoding: 1 });
    expect(ext4CaseFolding(superblock({ encoding: 1 }))).toEqual({ ok: true, casefold: false, encoding: 1 });
    expect(ext4CaseFolding(superblock({ magic: 0x1234 }))).toMatchObject({ ok: false, error: expect.stringContaining("0xEF53") });
    expect(ext4CaseFolding(superblock().subarray(0, 512))).toMatchObject({ ok: false, error: expect.stringContaining("512 of its 1024") });
  });

  // proves D-241 ruling 1: an ext4 without the feature passes; with it, or with an encoding, it is refused in plain words
  it("accepts an ext4 with case folding off, and refuses one with the casefold feature on, naming dumpe2fs", () => {
    expect(superblockRefusals(WORKSPACE, fakeIo())).toEqual([]);
    const on = superblockRefusals(WORKSPACE, fakeIo({ bytes: superblock({ casefold: true }) }));
    expect(on).toHaveLength(1);
    expect(on[0]).toMatch(/the workspace \/srv\/juno-work is on an ext4 file system \(\/dev\/sdc, mounted at \/\) with ext4's case-folding feature switched on \(casefold in its superblock\).*dumpe2fs -h \/dev\/sdc must not list casefold/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ bytes: superblock({ encoding: 1 }) }))[0]).toMatch(/a character encoding in its superblock/);
  });

  // proves D-242 (fail-closed): a superblock that cannot be read, or that is not the mount's block device, refuses
  it("refuses when the superblock cannot be read, or is not the mount's own block device", () => {
    expect(superblockRefusals(WORKSPACE, fakeIo({ readSuperblock: () => ({ ok: false, error: "EACCES: permission denied" }) }))[0]).toMatch(/cannot read the superblock of \/dev\/sdc.*EACCES.*run juno hook check as root, with sudo/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ readSuperblock: () => ({ ok: true, bytes: superblock(), blockDevice: null }) }))[0]).toMatch(/\/dev\/sdc is not the block device 8:32/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ readSuperblock: () => ({ ok: true, bytes: superblock(), blockDevice: { major: 8, minor: 0 } }) }))[0]).toMatch(/\/dev\/sdc is not the block device 8:32/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ bytes: superblock({ magic: 0 }) }))[0]).toMatch(/cannot be read as ext4's/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ deviceName: () => null }))[0]).toMatch(/cannot find the block device 8:32/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ deviceName: () => "../sdc" }))[0]).toMatch(/cannot find the block device 8:32/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ deviceOf: () => ({ major: 8, minor: 0 }) }))[0]).toMatch(/cannot tell which device holds/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ deviceOf: () => null }))[0]).toMatch(/cannot tell which device holds/);
    expect(superblockRefusals(WORKSPACE, fakeIo({ mountinfo: null }))[0]).toMatch(/cannot read \/proc\/self\/mountinfo/);
  });

  // proves D-242: a tmpfs passes here (D-178 judges its casefold option); btrfs, which no superblock read here confirms, is refused
  it("leaves a tmpfs to D-178's mount-option check, and refuses btrfs", () => {
    expect(superblockRefusals([{ what: "the workspace", path: "/tmp/work" }], fakeIo())).toEqual([]);
    const btrfs = fakeIo({ mountinfo: "25 1 0:33 / / rw - btrfs /dev/sdc rw" });
    expect(superblockRefusals(WORKSPACE, btrfs)[0]).toMatch(/is on a btrfs file system.*only on ext4, read from its superblock, or on a tmpfs/);
    // A type D-178 refuses is left to D-178, which gives its own reason.
    expect(superblockRefusals(WORKSPACE, fakeIo({ mountinfo: "25 1 0:33 / / rw - 9p drvfs rw" }))).toEqual([]);
  });

  // proves D-242: every ext4 mounted inside the workspace is read too, and a missing path is judged by its nearest existing ancestor
  it("reads the superblock of every mount inside the workspace, and judges a path not yet made by its ancestor", () => {
    const nested = fakeIo({ mountinfo: `${MOUNTINFO}\n50 25 8:48 / /srv/juno-work/inner rw - ext4 /dev/sdd rw` });
    expect(superblockRefusals(WORKSPACE, nested)).toEqual([expect.stringMatching(/a mount inside the workspace \/srv\/juno-work\/inner is on an ext4 file system \(\/dev\/sdd/)]);
    const missing = fakeIo({ bytes: superblock({ casefold: true }), realpath: (path) => (path.startsWith("/srv/juno-work") ? null : path) });
    expect(superblockRefusals(WORKSPACE, missing)[0]).toMatch(/the workspace \/srv\/juno-work is on an ext4 file system/);
  });

  // proves the dev_t split JUNO uses to find /sys/dev/block/<major>:<minor> (glibc's makedev, inverted)
  it("splits Linux device numbers as glibc does", () => {
    const makedev = (major: number, minor: number): bigint => (BigInt(minor) & 0xffn) | ((BigInt(major) & 0xfffn) << 8n) | ((BigInt(minor) & ~0xffn) << 12n) | ((BigInt(major) & ~0xfffn) << 32n);
    for (const [major, minor] of [[254, 0], [8, 32], [259, 70_000], [4_100, 1_048_000], [0, 40]] as const) expect(splitDevice(makedev(major, minor))).toEqual({ major, minor });
    expect(splitDevice(0xfe00n)).toEqual({ major: 254, minor: 0 });
  });

  const dir = mkdtempSync(join(tmpdir(), "juno-superblock-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // proves the system reader reads 1024 bytes at offset 1024, says a regular file is no block device, and follows no link
  it("reads the superblock's place from the file itself, and never through a symbolic link", () => {
    const image = join(dir, "image");
    const content = new Uint8Array(4096);
    content.set(superblock({ casefold: true }), SUPERBLOCK_OFFSET);
    writeFileSync(image, content);
    const read = systemSuperblockIo().readSuperblock(image);
    expect(read).toMatchObject({ ok: true, blockDevice: null });
    if (read.ok) expect(ext4CaseFolding(read.bytes)).toEqual({ ok: true, casefold: true, encoding: 1 });
    symlinkSync(image, join(dir, "link"));
    expect(systemSuperblockIo().readSuperblock(join(dir, "link"))).toMatchObject({ ok: false, error: expect.stringContaining("symbolic link") });
    expect(systemSuperblockIo().readSuperblock(join(dir, "absent"))).toMatchObject({ ok: false });
  });
});

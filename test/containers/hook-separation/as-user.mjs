// Container-test helper (D-173): run as root, drop to <uid>:<gid> holding exactly <groups> (a comma list, may be
// empty), then run <script> with the remaining arguments. Once every uid is non-zero the kernel clears every
// capability, so the script runs as an ordinary user. No shell.
import process from "node:process";

const [uid, gid, groups, script, ...rest] = process.argv.slice(2);
process.setgroups(groups === "" ? [] : groups.split(",").map(Number));
process.setgid(Number(gid));
process.setuid(Number(uid));
process.argv = [process.argv[0], script, ...rest];
await import(script);

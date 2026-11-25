// The systemd test's unit program (D-247): holds the journal `<journal>`'s one-writer lock with JUNO's own lock code
// from this build, as a service start takes it (a provably dead owner's lock is taken over, D-243), until SIGTERM, then
// releases it, as a clean stop does. Run by systemd as the unit the refusals name; never by a shell.
import process from "node:process";
import { setInterval } from "node:timers";

const [build, journal] = process.argv.slice(2);
const { acquireRunnerLock } = await import(`${build}/dist/journal/src/index.js`);
const lock = acquireRunnerLock(journal, undefined, undefined, { shown: journal });
process.stdout.write(`holding ${lock.path}${lock.cleared === null ? "" : ` (taken over: ${lock.cleared.reason})`}\n`);
process.on("SIGTERM", () => {
  lock.release();
  process.exit(0);
});
setInterval(() => undefined, 60_000);

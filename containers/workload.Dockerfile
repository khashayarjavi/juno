# juno-workload: the task isolation tier (build plan §1).
# Distroless: no shell, no package manager. Runs as the non-root user 65532.
# Network, capabilities, mounts and resource limits are set in docker-compose.yml.

# Source of the few programs the shell.run enum names (DECISIONS.md D-029) and
# of the /work mount point. Exec-form RUN only: no shell runs here either.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS programs
RUN ["mkdir", "-p", "/stage/work"]
# /usr/bin/ls needs libselinux and libpcre2-8 beside libc (DECISIONS.md D-067). They are found
# under whichever <arch>-linux-gnu directory this image uses and staged at the same path, owned
# by root: the workload user must not own any program or library it runs.
RUN ["node", "-e", "const fs = require('node:fs'); const path = require('node:path'); for (const lib of ['libselinux.so.1', 'libpcre2-8.so.0']) { const dirs = ['/lib', '/usr/lib'].flatMap((root) => fs.readdirSync(root).filter((name) => name.endsWith('-linux-gnu')).map((name) => path.join(root, name))); const dir = dirs.find((candidate) => fs.existsSync(path.join(candidate, lib))); if (dir === undefined) throw new Error('missing ' + lib); fs.mkdirSync(path.join('/libstage', dir), { recursive: true }); fs.copyFileSync(fs.realpathSync(path.join(dir, lib)), path.join('/libstage', dir, lib)); }"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

# /usr/bin/cat needs only libc, which this Debian 12 image already has.
COPY --from=programs /usr/bin/cat /usr/bin/cat
# /usr/bin/ls, the discovery program acceptance test 3 needs (D-029's forward record, D-067).
COPY --from=programs /usr/bin/ls /usr/bin/ls
# /usr/bin/sha256sum, the verifier's hashing program for verification-input pins (spec §3.4.4 B2, D-112).
# It needs only libc. It is in the shell.run enum but never offered to the executing model: its constant is the verifier's (§2.6 B1).
COPY --from=programs /usr/bin/sha256sum /usr/bin/sha256sum
COPY --from=programs /libstage/ /

# The work-vol mount point, owned by the workload user. A new named volume
# takes this ownership and mode on first mount (DECISIONS.md D-031).
COPY --from=programs --chown=65532:65532 --chmod=0755 /stage/ /

USER 65532:65532

# Nothing runs by default: capability invocations name their program
# explicitly (packages/registry). The image's entrypoint is node.
CMD ["--version"]

# juno-workload: the task isolation tier (build plan §1).
# Distroless: no shell, no package manager. Runs as the non-root user 65532.
# Network, capabilities, mounts and resource limits are set in docker-compose.yml.

# Source of the few programs the shell.run enum names (DECISIONS.md D-029) and
# of the /work mount point. Exec-form RUN only: no shell runs here either.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS programs
RUN ["mkdir", "-p", "/stage/work"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

# /usr/bin/cat needs only libc, which this Debian 12 image already has.
COPY --from=programs /usr/bin/cat /usr/bin/cat

# The work-vol mount point, owned by the workload user. A new named volume
# takes this ownership and mode on first mount (DECISIONS.md D-031).
COPY --from=programs --chown=65532:65532 --chmod=0755 /stage/ /

USER 65532:65532

# Nothing runs by default: capability invocations name their program
# explicitly (packages/registry). The image's entrypoint is node.
CMD ["--version"]

# juno-workload: the task isolation tier (build plan §1).
# Distroless: no shell, no package manager. Runs as the non-root user 65532.
# Network, capabilities and mounts are restricted in docker-compose.yml.
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

USER 65532:65532

# Increment 0 has no capability invocations to run; the container proves its
# runtime starts and exits cleanly. The image's entrypoint is node.
CMD ["--version"]

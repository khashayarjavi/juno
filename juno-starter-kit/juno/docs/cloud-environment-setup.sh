#!/bin/bash
# Paste this into the cloud environment's "Setup script" box (Claude desktop app →
# Cloud environment → Setup script). It runs once per environment cache (~7 days),
# before Claude Code starts. Every step is non-fatal: a failure must not block the session.

# Start Docker so base images can be pre-pulled into the cached snapshot.
if ! docker info >/dev/null 2>&1; then
  (nohup dockerd >/tmp/dockerd-setup.log 2>&1 &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

# Pre-pull likely base images (runner: slim Node; workload: shell-less distroless Node).
# Increment 0 may choose different ones; then update this list.
docker pull node:22-bookworm-slim || true
docker pull gcr.io/distroless/nodejs22-debian12:nonroot || true

exit 0

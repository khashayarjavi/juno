#!/bin/bash
# Runs at the start of every Claude Code session (see .claude/settings.json).
# Cloud sessions only: makes sure Docker is up and npm dependencies are installed.
# Always exits 0 so a hiccup never blocks the session; problems are printed instead.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || { echo "session-start: cannot cd to project dir"; exit 0; }

# 1. Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "session-start: Docker not responding, starting dockerd..."
  (nohup dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
if docker info >/dev/null 2>&1; then
  echo "session-start: Docker OK"
else
  echo "session-start: WARNING Docker still not responding. See /tmp/dockerd.log"
fi

# 2. npm dependencies (skipped until Increment 0 creates package-lock.json)
if [ -f package-lock.json ]; then
  hashes=node_modules/.session-start.sha256
  if ! sha256sum --check --status "$hashes" 2>/dev/null; then
    rm -f "$hashes"
    if npm ci; then
      mkdir -p node_modules
      sha256sum scripts/session-start.sh package.json package-lock.json > "$hashes" || rm -f "$hashes"
      echo "session-start: npm ci OK"
    else
      echo "session-start: WARNING npm ci failed"
    fi
  else
    echo "session-start: dependencies up to date"
  fi
else
  echo "session-start: no package-lock.json yet (expected before Increment 0)"
fi

exit 0

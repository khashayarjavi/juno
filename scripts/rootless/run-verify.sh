#!/bin/bash
# Runs `make verify-rootless` AS the runner's unprivileged user, against its rootless daemon (DECISIONS.md
# D-130, D-131). Run as root after scripts/rootless/setup-root.sh. The repository is copied into the user's
# home, because the user may not write the checkout; nothing is copied back.
#
#   sudo env JUNO_NODE_BIN="$(dirname "$(command -v node)")" bash scripts/rootless/run-verify.sh
set -euo pipefail

RUNNER_USER=juno-runner
[ "$(id -u)" = 0 ] || { echo "run-verify: run as root" >&2; exit 1; }
RUNNER_UID="$(id -u "$RUNNER_USER")"
RUNNER_HOME="$(getent passwd "$RUNNER_USER" | cut -d: -f6)"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
node_bin="${JUNO_NODE_BIN:-$(dirname "$(command -v node)")}"

rm -rf "$RUNNER_HOME/juno"
cp -a "$repo" "$RUNNER_HOME/juno"
rm -rf "$RUNNER_HOME/juno/dist" "$RUNNER_HOME/juno/build"
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME/juno"

# Pass the outbound proxy through when the machine has one (cloud sessions), with a CA bundle the user can read.
pass=()
for name in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy npm_config_https_proxy npm_config_noproxy; do
  if [ -n "${!name:-}" ]; then pass+=("$name=${!name}"); fi
done
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r "$NODE_EXTRA_CA_CERTS" ]; then
  install -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0644 "$NODE_EXTRA_CA_CERTS" "$RUNNER_HOME/.ca-bundle.crt"
  pass+=("NODE_EXTRA_CA_CERTS=$RUNNER_HOME/.ca-bundle.crt" "npm_config_cafile=$RUNNER_HOME/.ca-bundle.crt")
fi

cd "$RUNNER_HOME/juno"
exec runuser -u "$RUNNER_USER" -- env -i HOME="$RUNNER_HOME" \
  PATH="$node_bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/juno-rootless/bin" \
  XDG_RUNTIME_DIR="/run/user/$RUNNER_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNNER_UID/bus" \
  DOCKER_HOST="unix:///run/user/$RUNNER_UID/docker.sock" "${pass[@]}" \
  make verify-rootless

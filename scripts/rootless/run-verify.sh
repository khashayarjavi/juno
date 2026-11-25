#!/bin/bash
# Runs `make verify-rootless` AS the runner's unprivileged user, against its rootless daemon (DECISIONS.md
# D-130, D-131). Run as root after scripts/rootless/setup-root.sh. The repository is copied into the user's
# home, because the user may not write the checkout; nothing is copied back.
#
#   sudo env JUNO_NODE_BIN="$(dirname "$(command -v node)")" bash scripts/rootless/run-verify.sh [--login-shell]
#
# --login-shell runs it as the operator's guide does (docs/operator-setup.md Part E steps 8 and 11): in the runner's
# login shell, `sudo -iu juno-runner`, where Ubuntu gives the user the umask 0002, with `npm ci` run there too and the
# copy made group-writable as a clone there makes it. CI's `verify-rootless-operator` job uses it (D-219).
set -euo pipefail

login=false
for arg in "$@"; do
  case "$arg" in
    --login-shell) login=true ;;
    *) echo "run-verify: unknown argument $arg" >&2; exit 2 ;;
  esac
done

RUNNER_USER=juno-runner
[ "$(id -u)" = 0 ] || { echo "run-verify: run as root" >&2; exit 1; }
RUNNER_UID="$(id -u "$RUNNER_USER")"
RUNNER_HOME="$(getent passwd "$RUNNER_USER" | cut -d: -f6)"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
node_bin="${JUNO_NODE_BIN:-$(dirname "$(command -v node)")}"
# D-247: with systemd (CI's rootless jobs), the runner's user manager runs (setup-root.sh step 6), so the test that runs
# the service commands a refusal gives (test/containers/remedies-systemd.test.ts) must run against it, never skip.
systemd_user=0
if [ "$(cat /proc/1/comm)" = systemd ]; then systemd_user=1; fi

rm -rf "$RUNNER_HOME/juno"
cp -a "$repo" "$RUNNER_HOME/juno"
rm -rf "$RUNNER_HOME/juno/dist" "$RUNNER_HOME/juno/build"
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME/juno"
# No ACL from the checkout reaches the build context (see setup-root.sh step 2).
if command -v setfacl >/dev/null 2>&1; then setfacl -R -b -k "$RUNNER_HOME/juno"; fi

# Pass the outbound proxy through when the machine has one (cloud sessions), with a CA bundle the user can read.
pass=()
for name in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy npm_config_https_proxy npm_config_noproxy; do
  if [ -n "${!name:-}" ]; then pass+=("$name=${!name}"); fi
done
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r "$NODE_EXTRA_CA_CERTS" ]; then
  install -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0644 "$NODE_EXTRA_CA_CERTS" "$RUNNER_HOME/.ca-bundle.crt"
  pass+=("NODE_EXTRA_CA_CERTS=$RUNNER_HOME/.ca-bundle.crt" "npm_config_cafile=$RUNNER_HOME/.ca-bundle.crt")
fi

if [ "$login" = true ]; then
  mask="$(sudo -iu "$RUNNER_USER" -- umask)"
  echo "run-verify: the umask of the runner's login shell is $mask"
  # This mode exists to cover the operator's machine (issue #56); a different umask here would cover something else.
  [ "$mask" = 0002 ] || { echo "run-verify: expected 0002, the umask of the operator's login shell" >&2; exit 1; }
  find "$RUNNER_HOME/juno" ! -type l -exec chmod g+w {} +
  rm -rf "$RUNNER_HOME/juno/node_modules"
  as_login() {
    sudo -iu "$RUNNER_USER" -- env -i -C "$RUNNER_HOME/juno" HOME="$RUNNER_HOME" \
      PATH="$node_bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$RUNNER_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNNER_UID/bus" \
      DOCKER_HOST="unix:///run/user/$RUNNER_UID/docker.sock" JUNO_SYSTEMD_USER_REQUIRED="$systemd_user" "${pass[@]}" "$@"
  }
  as_login npm ci --no-audit --no-fund
  as_login make verify-rootless
  exit 0
fi

cd "$RUNNER_HOME/juno"
exec runuser -u "$RUNNER_USER" -- env -i HOME="$RUNNER_HOME" \
  PATH="$node_bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/juno-rootless/bin" \
  XDG_RUNTIME_DIR="/run/user/$RUNNER_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNNER_UID/bus" \
  DOCKER_HOST="unix:///run/user/$RUNNER_UID/docker.sock" JUNO_SYSTEMD_USER_REQUIRED="$systemd_user" "${pass[@]}" \
  make verify-rootless

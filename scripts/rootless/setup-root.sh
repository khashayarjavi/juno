#!/bin/bash
# Sets up the rootless container runtime JUNO's runner uses in real use (DECISIONS.md D-130, D-131), on a CI
# runner or in a cloud session, so its tests can run as the runner's unprivileged user. Run as root, once.
# It is NOT the operator's WSL2 setup: that is done by hand, click by click (STATE.md, Part E), with Docker's
# own packages. This script installs Docker's pinned static rootless binaries instead, so CI and cloud sessions
# run the same versions whatever Docker their machine already has.
#
#   sudo bash scripts/rootless/setup-root.sh [--preload-images]
#
# --preload-images copies the Dockerfiles' base images from the rootful daemon into the rootless one, for cloud
# sessions whose rootless daemon cannot reach the network (D-001). CI pulls them itself.
#
# What it does, each step fail-closed (set -euo pipefail):
#  1. installs uidmap (newuidmap, newgidmap), dbus-user-session and iproute2, which rootless mode needs;
#  2. creates the runner's user, juno-runner: no password, no login shell, no supplementary group;
#  3. installs Docker 29.9.2's static and rootless-extras binaries, root-owned, under /opt/juno-rootless/bin,
#     after checking each archive's SHA-256 (pinned below; computed 2026-11-04 from download.docker.com);
#  4. allows only that rootlesskit to create user namespaces, where AppArmor restricts them (Ubuntu 24.04);
#  5. writes the /etc/wsl.conf stand-in: interop off, Windows paths off, drive automount off (root-owned, 0644);
#  6. with systemd: delegates the cpu, cpuset, io, memory and pids controllers to user managers (Docker's
#     rootless docs, "Limiting resources"), enables lingering for the user, and installs and starts the
#     rootless daemon as a systemd user service with Docker's own setup tool;
#     without systemd (a cloud VM): starts the rootless daemon directly. Its limits are then NOT enforced,
#     which the rootless tests detect and fail on (D-131);
#  7. waits for the daemon's socket.
set -euo pipefail

RUNNER_USER=juno-runner
DOCKER_VERSION=29.9.2
DOCKER_SHA256=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb
EXTRAS_SHA256=f2663b230a7afc13dea88fc589685331d01f5f3fc458b92ab40e2388db452ed2
BIN=/opt/juno-rootless/bin
BASE_URL=https://download.docker.com/linux/static/stable/x86_64

preload=false
for arg in "$@"; do
  case "$arg" in
    --preload-images) preload=true ;;
    *) echo "setup-root: unknown argument $arg" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "setup-root: run as root" >&2; exit 1; }
if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "setup-root: this is WSL. Follow the operator steps in STATE.md (Part E) instead." >&2
  exit 1
fi
[ "$(uname -m)" = x86_64 ] || { echo "setup-root: only x86_64 is pinned" >&2; exit 1; }

echo "setup-root: 1. packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
apt-get install -y -q uidmap dbus-user-session iproute2 >/dev/null

echo "setup-root: 2. user $RUNNER_USER"
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/bash "$RUNNER_USER"
fi
usermod -G "" "$RUNNER_USER"
passwd -l "$RUNNER_USER" >/dev/null
grep -q "^$RUNNER_USER:" /etc/subuid || usermod --add-subuids 300000-365535 "$RUNNER_USER"
grep -q "^$RUNNER_USER:" /etc/subgid || usermod --add-subgids 300000-365535 "$RUNNER_USER"
RUNNER_UID="$(id -u "$RUNNER_USER")"
RUNNER_HOME="$(getent passwd "$RUNNER_USER" | cut -d: -f6)"

echo "setup-root: 3. Docker $DOCKER_VERSION rootless binaries in $BIN"
download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
curl -fsSL --max-time 300 -o "$download/docker.tgz" "$BASE_URL/docker-$DOCKER_VERSION.tgz"
curl -fsSL --max-time 300 -o "$download/extras.tgz" "$BASE_URL/docker-rootless-extras-$DOCKER_VERSION.tgz"
echo "$DOCKER_SHA256  $download/docker.tgz" | sha256sum -c --quiet -
echo "$EXTRAS_SHA256  $download/extras.tgz" | sha256sum -c --quiet -
rm -rf "$BIN"
mkdir -p "$BIN"
tar xzf "$download/docker.tgz" -C "$BIN" --strip-components=1 --no-same-owner
tar xzf "$download/extras.tgz" -C "$BIN" --strip-components=1 --no-same-owner
chown -R root:root /opt/juno-rootless
chmod -R go-w /opt/juno-rootless

echo "setup-root: 4. AppArmor"
if [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then
  profile=/etc/apparmor.d/opt.juno-rootless.bin.rootlesskit
  cat > "$profile" <<PROFILE
abi <abi/4.0>,
include <tunables/global>

"$BIN/rootlesskit" flags=(unconfined) {
  userns,

  include if exists <local/opt.juno-rootless.bin.rootlesskit>
}
PROFILE
  apparmor_parser -r "$profile"
else
  echo "setup-root:    AppArmor not active; nothing to do"
fi

echo "setup-root: 5. /etc/wsl.conf stand-in"
cat > /etc/wsl.conf <<CONF
# JUNO (DECISIONS.md D-130, D-131): only root may change this file.
[boot]
systemd=true

[interop]
enabled=false
appendWindowsPath=false

[automount]
enabled=false

[user]
default=$RUNNER_USER
CONF
chown root:root /etc/wsl.conf
chmod 0644 /etc/wsl.conf

as_runner() {
  runuser -u "$RUNNER_USER" -- env -i HOME="$RUNNER_HOME" PATH="$BIN:/usr/sbin:/usr/bin:/sbin:/bin" \
    XDG_RUNTIME_DIR="/run/user/$RUNNER_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNNER_UID/bus" "$@"
}

if [ "$(cat /proc/1/comm)" = systemd ]; then
  echo "setup-root: 6. systemd: delegation, lingering, user service"
  mkdir -p /etc/systemd/system/user@.service.d
  cat > /etc/systemd/system/user@.service.d/delegate.conf <<UNIT
[Service]
Delegate=cpu cpuset io memory pids
UNIT
  systemctl daemon-reload
  loginctl enable-linger "$RUNNER_USER"
  for _ in $(seq 1 60); do [ -S "/run/user/$RUNNER_UID/bus" ] && break; sleep 1; done
  [ -S "/run/user/$RUNNER_UID/bus" ] || { echo "setup-root: the user's systemd manager did not start" >&2; exit 1; }
  # The user manager may have started before the drop-in; restart it so the delegation applies.
  systemctl restart "user@$RUNNER_UID.service"
  for _ in $(seq 1 60); do [ -S "/run/user/$RUNNER_UID/bus" ] && break; sleep 1; done
  as_runner "$BIN/dockerd-rootless-setuptool.sh" install
  as_runner systemctl --user enable --now docker.service
else
  echo "setup-root: 6. no systemd: starting the rootless daemon directly (cgroup limits will not be enforced)"
  mkdir -p "/run/user/$RUNNER_UID"
  chown "$RUNNER_USER:$RUNNER_USER" "/run/user/$RUNNER_UID"
  chmod 0700 "/run/user/$RUNNER_UID"
  # Stock udev gives /dev/net/tun mode 0666; some VMs ship it 0600, which rootless networking cannot open.
  [ -c /dev/net/tun ] && chmod 0666 /dev/net/tun
  if ! as_runner "$BIN/docker" --host "unix:///run/user/$RUNNER_UID/docker.sock" info >/dev/null 2>&1; then
    # setsid -f: the daemon is detached from this script and holds none of its file descriptors.
    cd "$RUNNER_HOME"
    setsid -f runuser -u "$RUNNER_USER" -- env -i HOME="$RUNNER_HOME" PATH="$BIN:/usr/sbin:/usr/bin:/sbin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$RUNNER_UID" "$BIN/dockerd-rootless.sh" </dev/null >/tmp/juno-rootless-dockerd.log 2>&1
    cd - >/dev/null
  fi
fi

echo "setup-root: 7. waiting for the rootless daemon"
socket="/run/user/$RUNNER_UID/docker.sock"
for _ in $(seq 1 90); do
  as_runner "$BIN/docker" --host "unix://$socket" info >/dev/null 2>&1 && break
  sleep 1
done
as_runner "$BIN/docker" --host "unix://$socket" info --format 'rootless daemon {{.ServerVersion}}: cgroup v{{.CgroupVersion}}, driver {{.CgroupDriver}}, {{json .SecurityOptions}}'

if [ "$preload" = true ]; then
  echo "setup-root: preloading base images from the rootful daemon"
  repo="$(cd "$(dirname "$0")/../.." && pwd)"
  for image in $(grep -h '^FROM ' "$repo"/containers/*.Dockerfile | awk '{print $2}' | sort -u); do
    docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
    docker save "$image" | as_runner "$BIN/docker" --host "unix://$socket" load >/dev/null
    echo "setup-root:    $image"
  done
fi
echo "setup-root: done"

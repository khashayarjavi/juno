#!/bin/bash
# Sets up the rootless container runtime JUNO's runner uses in real use (DECISIONS.md D-130, D-131), on a CI
# runner or in a cloud session, so its tests can run as the runner's unprivileged user. Run as root, once.
# It is NOT the operator's WSL2 setup: that is done by hand, click by click (STATE.md, Part E), with Docker's
# own packages. This script installs Docker's pinned static rootless binaries instead, so CI and cloud sessions
# run the same versions whatever Docker their machine already has.
#
#   sudo bash scripts/rootless/setup-root.sh [--preload-images] [--docker-from-apt]
#
# --preload-images copies the Dockerfiles' base images from the rootful daemon into the rootless one, for cloud
# sessions whose rootless daemon cannot reach the network (D-001). CI pulls them itself.
#
# --docker-from-apt installs Docker the way the operator's guide does instead (docs/operator-setup.md Part E steps 3
# and 4): Docker's own apt packages at the guide's pinned version, then the root-run Docker switched off with nobody
# left in the docker group. CI's `verify-rootless-operator` job uses it, so CI covers the operator's setup (D-219).
#
# What it does, each step fail-closed (set -euo pipefail):
#  1. installs uidmap (newuidmap, newgidmap), dbus-user-session and iproute2, which rootless mode needs;
#  2. creates the runner's user, juno-runner: password locked, no supplementary group, no ACL on its home;
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

# The guide's pinned apt version (docs/operator-setup.md Part E step 3); test/evidence/operator-setup.test.ts keeps them equal.
APT_VERSION=5:29.9.2-1~ubuntu.24.04~noble

preload=false
from_apt=false
for arg in "$@"; do
  case "$arg" in
    --preload-images) preload=true ;;
    --docker-from-apt) from_apt=true ;;
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
apt-get install -y -q uidmap dbus-user-session iproute2 acl >/dev/null

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
# A default ACL inherited from /home (GitHub's runner image has one) names a uid the rootless user namespace does not
# map; every directory the daemon creates would inherit it, and copying a mount point into a new volume then fails
# with EINVAL. The runner's home gets no ACL at all.
getfacl -p /home "$RUNNER_HOME" 2>/dev/null | grep -E '^(# file|default:|user:[^:])' | sed 's/^/setup-root:    acl before: /' || true
setfacl -R -b -k "$RUNNER_HOME"

download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
if [ "$from_apt" = true ]; then
  BIN=/usr/bin
  echo "setup-root: 3. Docker $APT_VERSION from Docker's apt repository, as the guide installs it (Part E steps 3, 4)"
  # Only the guide's source for Docker's repository: another one naming it with a different key makes apt refuse both.
  { grep -l 'download.docker.com' /etc/apt/sources.list.d/* 2>/dev/null || true; } | while read -r other; do
    echo "setup-root:    removing the machine's own source $other"
    rm -f "$other"
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL --max-time 120 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n' > /etc/apt/sources.list.d/docker.sources
  apt-get update -q >/dev/null
  apt-get install -y -q --allow-downgrades "docker-ce=$APT_VERSION" "docker-ce-cli=$APT_VERSION" "docker-ce-rootless-extras=$APT_VERSION" \
    containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  dpkg-query -W -f 'setup-root:    ${Package} ${Version}\n' docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io
  [ "$(dpkg-query -W -f '${Version}' docker-ce-rootless-extras)" = "$APT_VERSION" ] || { echo "setup-root: docker-ce-rootless-extras is not $APT_VERSION" >&2; exit 1; }
  # Part E step 4: anyone who can reach the root-run Docker is root.
  systemctl disable --now docker.service docker.socket
  rm -f /var/run/docker.sock
  for member in $(getent group docker | cut -d: -f4 | tr ',' ' '); do gpasswd -d "$member" docker >/dev/null; done
  echo "setup-root:    $(getent group docker)"
  [ -z "$(getent group docker | cut -d: -f4)" ] || { echo "setup-root: the docker group still has members" >&2; exit 1; }
else
  echo "setup-root: 3. Docker $DOCKER_VERSION rootless binaries in $BIN"
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
fi

echo "setup-root: 4. AppArmor"
shipped="$(grep -ls "^[^#]*$BIN/rootlesskit" /etc/apparmor.d/* 2>/dev/null | head -n 1 || true)"
if [ "$from_apt" = true ] && [ -n "$shipped" ]; then
  # Docker's deb ships its own rootlesskit profile (DECISIONS.md D-130); the guide relies on it, and so does this job.
  echo "setup-root:    the package's own profile: $shipped"
elif [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then
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
# D-173: a WSL terminal opens as the Claude Code user, never as the runner (STATE.md Part E).
default=juno-agent
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
  diagnose() {
    systemctl status "user@$RUNNER_UID.service" --no-pager || true
    journalctl -u "user@$RUNNER_UID.service" --no-pager -n 60 || true
    journalctl _SYSTEMD_USER_UNIT=docker.service --no-pager -n 60 || true
  }
  trap 'rm -rf "$download"; diagnose' ERR
  # The drop-in is in place before the user's manager first starts, so the delegation applies to it.
  if systemctl is-active --quiet "user@$RUNNER_UID.service"; then
    echo "setup-root: user@$RUNNER_UID.service was already running; it must start after the drop-in" >&2
    exit 1
  fi
  loginctl enable-linger "$RUNNER_USER"
  for _ in $(seq 1 90); do [ -S "/run/user/$RUNNER_UID/bus" ] && break; sleep 1; done
  [ -S "/run/user/$RUNNER_UID/bus" ] || { echo "setup-root: the user's systemd manager did not start" >&2; diagnose; exit 1; }
  controllers="/sys/fs/cgroup/user.slice/user-$RUNNER_UID.slice/user@$RUNNER_UID.service/cgroup.controllers"
  echo "setup-root:    delegated to the user: $(cat "$controllers")"
  # The user's manager can inherit another user's XDG_RUNTIME_DIR or HOME from global environment files (GitHub's
  # runner image sets them in /etc/environment); the rootless daemon then refuses to start. Give the manager its own.
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' /etc/environment 2>/dev/null | tr '\n' ' ' | sed 's/^/setup-root:    names in \/etc\/environment: /' || true
  echo
  as_runner systemctl --user set-environment "XDG_RUNTIME_DIR=/run/user/$RUNNER_UID" "HOME=$RUNNER_HOME" \
    "XDG_CONFIG_HOME=$RUNNER_HOME/.config" "XDG_DATA_HOME=$RUNNER_HOME/.local/share" \
    "XDG_CACHE_HOME=$RUNNER_HOME/.cache" "XDG_STATE_HOME=$RUNNER_HOME/.local/state"
  as_runner systemctl --user unset-environment DOCKER_HOST DOCKER_CONFIG DOCKER_CONTEXT
  if ! as_runner "$BIN/dockerd-rootless-setuptool.sh" install; then
    journalctl _UID="$RUNNER_UID" --no-pager -n 80 || true
    diagnose
    exit 1
  fi
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
storage="$(as_runner "$BIN/docker" --host "unix://$socket" info --format '{{.Driver}} {{json .DriverStatus}}')"
echo "setup-root:    storage: $storage"
if [ "$from_apt" = true ] && ! grep -q 'io.containerd.snapshotter.v1' <<<"$storage"; then
  # The operator's daemon stores images with containerd's snapshotter (issue #56's docker info); this job must too.
  echo "setup-root: the rootless daemon does not use containerd's snapshotter, as the operator's does" >&2
  exit 1
fi

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

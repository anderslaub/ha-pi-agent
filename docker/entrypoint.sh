#!/bin/sh
# Prepares the workspace and pi, then runs the command (the headless va-bridge by default).
set -eu

WS="${PI_BRIDGE_CWD:-/workspace}"

# --- as root: match the host user, fix ownership, then drop privileges --------------------------------
if [ "$(id -u)" = 0 ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  [ "$(id -g node)" = "$PGID" ] || groupmod -o -g "$PGID" node
  [ "$(id -u node)" = "$PUID" ] || usermod -o -u "$PUID" node
  mkdir -p "$WS" /home/node/.pi/agent
  # Docker creates a missing bind-mount folder as root: hand it over (not recursively: never touch your files)
  [ "$(stat -c %u "$WS")" = "$PUID" ] || chown "$PUID:$PGID" "$WS"
  [ "$(stat -c %u /home/node/.pi)" = "$PUID" ] || chown -R "$PUID:$PGID" /home/node/.pi
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$0" "$@"
fi

# --- as the node user ---------------------------------------------------------------------------------
mkdir -p "$WS"

# First start in this workspace: give it a system prompt for the assistant.
# .pi/SYSTEM.md replaces pi's coding-agent prompt for sessions in this folder. Edit it on the host.
if [ ! -d "$WS/.pi" ]; then
  mkdir -p "$WS/.pi"
  if [ -f /opt/va-bridge/docker/SYSTEM.md ]; then
    cp /opt/va-bridge/docker/SYSTEM.md "$WS/.pi/SYSTEM.md"
  else
    cp /opt/va-bridge/docker/SYSTEM.md.example "$WS/.pi/SYSTEM.md"
  fi
  echo "[entrypoint] created $WS/.pi/SYSTEM.md"
fi

# Make /va-bridge available in interactive pi too (docker compose exec -u node va-bridge pi).
# The settings live in the volume, so only do this once.
SETTINGS="$HOME/.pi/agent/settings.json"
if ! grep -q '/opt/va-bridge' "$SETTINGS" 2>/dev/null; then
  pi install /opt/va-bridge >/dev/null && echo "[entrypoint] installed the va-bridge pi package"
fi

# Extra pi packages, e.g. PI_PACKAGES="npm:pi-web-access git:github.com/user/repo"
for pkg in ${PI_PACKAGES:-}; do
  name="${pkg#npm:}"; name="${name#git:}"; name="${name%@*}"
  if ! grep -q "$name" "$SETTINGS" 2>/dev/null; then
    echo "[entrypoint] installing pi package $pkg"
    pi install "$pkg" || echo "[entrypoint] WARNING: could not install $pkg"
  fi
done

if [ -z "${PI_BRIDGE_TOKEN:-}" ]; then
  echo "[entrypoint] PI_BRIDGE_TOKEN is not set (generate one: openssl rand -hex 24)" >&2
  exit 1
fi

exec "$@"

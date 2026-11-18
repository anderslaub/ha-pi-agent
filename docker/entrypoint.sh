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
  # ... the same for the folders Docker creates for the SYSTEM.md mount
  for d in "$WS/.pi" "$WS/.pi/va-bridge"; do
    [ ! -d "$d" ] || [ "$(stat -c %u "$d")" = "$PUID" ] || chown "$PUID:$PGID" "$d"
  done
  # pi's state must belong to the node user, also files a "docker exec" as root may have left behind
  find /home/node/.pi \( ! -uid "$PUID" -o ! -gid "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$0" "$@"
fi

# --- as the node user ---------------------------------------------------------------------------------
mkdir -p "$WS"

# No system prompt mounted or written yet (plain "docker run"): start from the example.
# .pi/va-bridge/SYSTEM.md replaces pi's coding-agent prompt for assistant sessions.
PROMPT="$WS/.pi/va-bridge/SYSTEM.md"
if [ -d "$PROMPT" ]; then
  echo "[entrypoint] docker/SYSTEM.md is missing, so Docker mounted a folder instead. Remove the docker/SYSTEM.md" >&2
  echo "[entrypoint] folder, then: cp SYSTEM.md.example SYSTEM.md, and docker compose up -d" >&2
  exit 1
fi
if [ ! -e "$PROMPT" ]; then
  mkdir -p "$(dirname "$PROMPT")"
  cp /opt/va-bridge/docker/SYSTEM.md.example "$PROMPT"
  echo "[entrypoint] created $PROMPT from the example"
fi

# Make /va-bridge available in interactive pi too (docker compose exec va-bridge pi).
# The settings live in the volume, so only do this once.
SETTINGS="$HOME/.pi/agent/settings.json"
if ! grep -q '/opt/va-bridge' "$SETTINGS" 2>/dev/null; then
  pi install /opt/va-bridge >/dev/null && echo "[entrypoint] installed the va-bridge pi package"
fi

# Extra pi packages, e.g. PI_PACKAGES="npm:pi-web-access git:github.com/user/repo"
# npm 12 skips the install scripts (postinstall, ...) of packages it was not told to trust. The npm packages
# in PI_PACKAGES are trusted; PI_ALLOW_SCRIPTS adds more, comma separated (e.g. dependencies that need theirs).
pkg_name() { # npm:@scope/name@1.2 -> @scope/name
  n="${1#npm:}"; n="${n#git:}"
  case "${n#@}" in *@*) n="${n%@*}" ;; esac
  printf '%s' "$n"
}
ALLOW="${PI_ALLOW_SCRIPTS:-}"
for pkg in ${PI_PACKAGES:-}; do
  case "$pkg" in npm:*) ALLOW="${ALLOW:+$ALLOW,}$(pkg_name "$pkg")" ;; esac
done
if [ -n "$ALLOW" ]; then
  echo "allow-scripts=$ALLOW" > "$HOME/.npmrc"
else
  rm -f "$HOME/.npmrc"
fi

for pkg in ${PI_PACKAGES:-}; do
  name="$(pkg_name "$pkg")"
  if ! grep -q "$name" "$SETTINGS" 2>/dev/null; then
    echo "[entrypoint] installing pi package $pkg"
    pi install "$pkg" || echo "[entrypoint] WARNING: could not install $pkg"
  fi
done

# Run the install scripts of trusted packages that were installed while they were blocked (once per version)
NPM_ROOT="$HOME/.pi/agent/npm"
for name in $(printf '%s' "$ALLOW" | tr ',' ' '); do
  pj="$NPM_ROOT/node_modules/$name/package.json"
  [ -f "$pj" ] || continue
  ver="$(node -p "require('$pj').version" 2>/dev/null || echo unknown)"
  mark="$NPM_ROOT/.scripts-ran/$(printf '%s' "$name" | tr '/' '+')@$ver"
  [ -e "$mark" ] && continue
  if npm rebuild "$name" --prefix "$NPM_ROOT" >/dev/null 2>&1; then
    mkdir -p "$NPM_ROOT/.scripts-ran" && touch "$mark"
    echo "[entrypoint] ran the install scripts of $name@$ver"
  else
    echo "[entrypoint] WARNING: the install scripts of $name failed (npm rebuild $name --prefix $NPM_ROOT)"
  fi
done

if [ -z "${PI_BRIDGE_TOKEN:-}" ]; then
  echo "[entrypoint] PI_BRIDGE_TOKEN is not set (generate one: openssl rand -hex 24)" >&2
  exit 1
fi

exec "$@"

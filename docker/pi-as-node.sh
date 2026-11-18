#!/bin/sh
# pi, but always as the "node" user, so `docker exec -it pi-va-bridge pi` just works.
# (/usr/local/sbin comes before /usr/local/bin, where npm put the real pi.)
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid="$(id -u node)" --regid="$(id -g node)" --init-groups env HOME=/home/node /usr/local/bin/pi "$@"
fi
exec /usr/local/bin/pi "$@"

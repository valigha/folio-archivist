#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"

umask "$UMASK"

mkdir -p /app/config /app/hentai /app/log

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" folio 2>/dev/null || addgroup -g "$PGID" -S folio
  fi
  GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -D -H -u "$PUID" -G "$GROUP_NAME" folio 2>/dev/null || true
  fi
  # config and log are small: fix them right away.
  chown -R "$PUID:$PGID" /app/config /app/log || true
  # The library can hold tens of thousands of files, and a recursive chown over it
  # can take minutes, during which the page would not load at all. Fix the top
  # folder now and the rest in the background, and skip it entirely when the
  # library already belongs to the right user.
  LIB_OWNER="$(stat -c '%u:%g' /app/hentai 2>/dev/null || echo none)"
  if [ "$LIB_OWNER" != "$PUID:$PGID" ]; then
    chown "$PUID:$PGID" /app/hentai || true
    (chown -R "$PUID:$PGID" /app/hentai >/dev/null 2>&1 || true) &
  fi
  exec su-exec "$PUID:$PGID" node /app/worker.mjs
fi

exec node /app/worker.mjs

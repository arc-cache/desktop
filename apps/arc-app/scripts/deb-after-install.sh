#!/bin/sh
set -eu

sandbox="/opt/ARC/chrome-sandbox"

if [ -f "$sandbox" ]; then
  chown root:root "$sandbox" || true
  chmod 4755 "$sandbox" || true
fi

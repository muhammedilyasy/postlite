#!/bin/sh
# Consistent online backup of postlite: SQLite snapshot (safe while running) + uploads.
# Usage: deploy/backup.sh [/path/to/backup-dir]
set -eu
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
DEST="${1:-$APP_DIR/backups}/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
# VACUUM INTO produces a consistent copy even while the server is writing (WAL mode).
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"VACUUM INTO '\"+process.argv[2].replace(/'/g,\"''\")+\"'\");d.close()" \
  "$DATA_DIR/postlite.sqlite" "$DEST/postlite.sqlite"
cp -a "$DATA_DIR/uploads" "$DEST/uploads"
echo "Backup written to $DEST (keep TOKEN_ENC_KEY from .env too — tokens are encrypted with it)"

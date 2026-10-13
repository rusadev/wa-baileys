#!/usr/bin/env bash
# Manual:          /root/deploy-wa-baileys.sh
# GitHub Actions:  ssh ... (forced command runs this script)
set -euo pipefail

APP_DIR=/var/www/wa.rusabyte.co.id
LOCK=/tmp/deploy-wa-baileys.lock

exec 9>"$LOCK"
flock -n 9 || { echo "Deploy lain sedang berjalan"; exit 1; }

cd "$APP_DIR"

retry() {
  local attempt=1
  until "$@"; do
    [ "$attempt" -ge 5 ] && { echo "Gagal 5x: $*"; return 1; }
    echo "Gagal, mencoba lagi ($attempt/5): $*"
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
}

# Pertahankan session WhatsApp & secrets
[ -f .env ] || { echo "Missing .env di $APP_DIR"; exit 1; }

retry git fetch --quiet origin main
git merge --ff-only origin/main

retry npm ci --omit=dev --no-audit --no-fund

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "Deploy selesai: $(git log --oneline -1)"

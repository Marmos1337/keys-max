#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Установите Node.js 22.16+ или 24 LTS: https://nodejs.org/en/download'; exit 1; }
node scripts/setup.mjs
exec node --env-file-if-exists=.env server/index.mjs

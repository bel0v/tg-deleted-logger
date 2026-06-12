#!/usr/bin/env bash
set -euo pipefail

cd /opt/tg-logger
git pull --ff-only
npm ci
npm run build
sudo systemctl restart tg-logger
sudo systemctl status tg-logger --no-pager

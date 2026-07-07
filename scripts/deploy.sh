#!/usr/bin/env bash
set -euo pipefail

# Runs as a sudo-enabled user (NOT as tglogger).
#
# The code-update steps run as root and chown back to tglogger at the end
# (keeps file ownership consistent after npm ci). The systemd egress sandbox
# confines only the running service, not this deploy or a tglogger shell.

sudo bash -c '
	set -euo pipefail
	cd /opt/tg-logger
	git -c safe.directory=/opt/tg-logger pull --ff-only
	npm ci
	npm run build
	chown -R tglogger:tglogger .
'

DEPLOYED_SHA=$(sudo git -C /opt/tg-logger -c safe.directory=/opt/tg-logger rev-parse --short HEAD)
sudo logger -t tg-deploy "restarting tg-logger after deploy ($DEPLOYED_SHA)"
sudo systemctl restart tg-logger
sudo systemctl status tg-logger --no-pager

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

# Sync the systemd unit if it changed in the repo, so unit edits actually take
# effect (git pull alone leaves /etc/systemd/system/ stale).
if ! sudo cmp -s /opt/tg-logger/systemd/tg-logger.service /etc/systemd/system/tg-logger.service; then
	echo "systemd unit changed — reinstalling"
	sudo cp /opt/tg-logger/systemd/tg-logger.service /etc/systemd/system/tg-logger.service
	sudo systemctl daemon-reload
fi

DEPLOYED_SHA=$(sudo git -C /opt/tg-logger -c safe.directory=/opt/tg-logger rev-parse --short HEAD)
sudo logger -t tg-deploy "restarting tg-logger after deploy ($DEPLOYED_SHA)"
sudo systemctl restart tg-logger
sudo systemctl status tg-logger --no-pager

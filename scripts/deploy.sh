#!/usr/bin/env bash
set -euo pipefail

# Runs as a sudo-enabled user (NOT as tglogger).
#
# The tglogger user is firewalled to Telegram DCs only and can't reach
# github / registry.npmjs.org, so the code-update steps run as root
# (unrestricted outbound) and chown back to tglogger at the end.

sudo bash -c '
	set -euo pipefail
	cd /opt/tg-logger
	git -c safe.directory=/opt/tg-logger pull --ff-only
	npm ci
	npm run build
	chown -R tglogger:tglogger .
'

sudo systemctl restart tg-logger
sudo systemctl status tg-logger --no-pager

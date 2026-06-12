# tg-deleted-logger

Self-hosted Telegram userbot that captures every incoming DM and preserves messages the sender later deletes or silently edits.

## Prerequisites

- Node.js **>= 24** (the systemd unit assumes `/usr/bin/node`)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org) → API development tools
- A Linux box with `systemd` and `nftables` for the production deploy

## Local setup (first time)

```bash
git clone git@github.com:bel0v/tg-deleted-logger.git
cd tg-deleted-logger
npm install                # also installs the pre-commit / pre-push hooks
cp .env.example .env       # fill in TG_API_ID and TG_API_HASH
```

Generate a session string interactively (phone + SMS code + 2FA password if set):

```bash
npm run login
```

The script prints a long session string. Paste it into `.env` as `TG_SESSION=...` for local runs.

Smoke-test against your account:

```bash
npm run dev
```

Send yourself a message from another account, then edit and delete it. You should see `event=new` → `event=edit` → `event=delete` log lines.

## Server deployment

### One-time server setup

Run these as root on a fresh Linux box (Debian/Ubuntu assumed).

**1. Install Node 24 and nftables.**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs nftables
```

**2. Create an unprivileged user and working dir.**

```bash
sudo useradd -r -s /usr/sbin/nologin tglogger
sudo mkdir -p /opt/tg-logger/data
sudo chown -R tglogger:tglogger /opt/tg-logger
```

**3. Clone the repo and install deps.**

```bash
sudo -u tglogger git clone https://github.com/bel0v/tg-deleted-logger /opt/tg-logger
cd /opt/tg-logger
sudo -u tglogger npm ci
sudo -u tglogger npm run build
```

**4. Apply the firewall.**

Locks the `tglogger` user's outbound to Telegram DCs + DNS only. Root and your SSH user keep normal outbound so deploys work.

```bash
sudo cp /opt/tg-logger/deploy/firewall.nft /etc/nftables.conf
sudo systemctl enable --now nftables
```

Verify by trying to `curl -m 3 https://example.com` as `tglogger` — it should hang and time out:

```bash
sudo -u tglogger curl -m 3 https://example.com   # should fail
sudo -u tglogger curl -m 3 https://149.154.167.50  # should succeed
```

**5. Mount the session as an encrypted systemd credential.**

You should have generated `TG_SESSION` locally during setup (step above). On the server:

```bash
sudo mkdir -p /etc/credstore.encrypted
sudo systemd-creds encrypt --name=tg-session - /etc/credstore.encrypted/tg-session
# paste the session string, then Ctrl-D
sudo chmod 600 /etc/credstore.encrypted/tg-session
```

**6. Create the env file** (non-secret config: API ID/hash, optional tunables).

```bash
sudo tee /etc/tg-logger.env >/dev/null <<EOF
TG_API_ID=...
TG_API_HASH=...
# Optional. Defaults: 600000 ms (10 min) reconcile, 90 day retention.
# TG_RECONCILE_INTERVAL_MS=600000
# TG_RETENTION_DAYS=90
# LOG_LEVEL=info
EOF
sudo chmod 600 /etc/tg-logger.env
```

**7. Install and start the systemd unit.**

```bash
sudo cp /opt/tg-logger/systemd/tg-logger.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-logger
journalctl -u tg-logger -f
```

You should see `connected` and `reconcile loop started` within a few seconds.

### Subsequent deploys

After committing and pushing changes from your laptop, on the server:

```bash
sudo -u tglogger /opt/tg-logger/scripts/deploy.sh
```

The script does `git pull --ff-only && npm ci && npm run build && systemctl restart tg-logger` and prints the unit status at the end.

## Operations

**Tail live logs:**

```bash
journalctl -u tg-logger -f
```

**Query deletions:**

```bash
sudo -u tglogger sqlite3 /opt/tg-logger/data/messages.db \
  "SELECT m.msg_id, m.text, u.first_name, m.deleted_at
   FROM messages m
   LEFT JOIN users u ON u.user_id = m.sender_id
   WHERE m.deleted_at IS NOT NULL
   ORDER BY m.deleted_at DESC
   LIMIT 50"
```

**Inspect edit history:**

```bash
sudo -u tglogger sqlite3 /opt/tg-logger/data/messages.db \
  "SELECT msg_id, text, observed_at FROM message_revisions ORDER BY observed_at DESC LIMIT 20"
```

**Rotate the session** (if it leaks or you want to force re-auth):

1. Generate a new session locally: `npm run login`
2. On the server:
   ```bash
   sudo systemd-creds encrypt --name=tg-session - /etc/credstore.encrypted/tg-session
   # paste new session, Ctrl-D
   sudo systemctl restart tg-logger
   ```

## Development

```bash
npm run dev          # tsx watch — auto-reload on src/* changes
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx
npm run check        # biome check --write (autofix)
npm run verify       # biome check && tsc --noEmit (no autofix, pre-commit gate)
npm run build        # tsc → dist/
```

`pre-commit` runs `verify`. `pre-push` runs `test`. Both via `simple-git-hooks`, installed on `npm install`.

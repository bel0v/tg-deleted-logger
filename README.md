# tg-deleted-logger

Self-hosted Telegram userbot that watches your incoming DMs and **forwards every edit and deletion to a Telegram chat of your choice**, with the original content (text, photos, voice notes, video — including "view once" media) attached. Two detection paths:

- **Live** — Telegram's `EditedMessage` / `DeletedMessage` push update.
- **Reconciliation** — every 10 min the bot diffs its in-memory cache against Telegram's view and catches anything Telegram quietly forgot to tell it about.

The local cache lives in RAM only and is purged after 24 hours by default. **Telegram is your archive.**

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

Send yourself a message from another account, then edit and delete it. You should see `event=new` → `event=edit` → `event=delete` log lines, and notifications arrive in your Saved Messages (the default target).

## Notification target

By default, notifications go to your own **Saved Messages** (`TG_NOTIFY_CHAT_ID=me`). For a cleaner experience, send them to a **dedicated private channel** so they don't mix with your real saved content:

1. In Telegram, create a new private channel (yourself as the only member).
2. Add your userbot account to it as an admin.
3. Find the channel's numeric ID — Telegram desktop's dev console or a bot like `@username_to_id_bot` works. The value looks like `-1001234567890`.
4. Set `TG_NOTIFY_CHAT_ID=-1001234567890` in `/etc/tg-logger.env`.
5. Restart: `sudo systemctl restart tg-logger`.

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
sudo -u tglogger curl -m 3 https://example.com    # should fail
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
TG_NOTIFY_CHAT_ID=me              # or -1001234567890 for a dedicated channel
# Optional. Defaults shown below.
# TG_MEDIA_DIR=/opt/tg-logger/data/media
# TG_RECONCILE_INTERVAL_MS=600000  # 10 min
# TG_RETENTION_DAYS=1
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

You should see `connected`, `notifier ready`, `reconcile loop started`, and `retention loop started` within a few seconds.

### Subsequent deploys

After committing and pushing changes from your laptop, on the server:

```bash
sudo -u tglogger /opt/tg-logger/scripts/deploy.sh
```

The script does `git pull --ff-only && npm ci && npm run build && systemctl restart tg-logger` and prints the unit status at the end.

## How notifications look

**Text deletion:**
```
🗑️ Deleted by John Doe

Hey, just kidding about Mondays
```

**Silent (reconciler-detected) deletion:**
```
🗑️ Deleted by John Doe (silent)

Hey, just kidding about Mondays
```

**View-once media deletion** (the highest-value capture case):
```
[forwarded photo / video / voice]
🗑️ 🔥 view-once Deleted by John Doe
```

**Edit:**
```
✏️ Edited by John Doe

— before —
I hate Mondays

— after —
I love Mondays
```

## Operations

**Tail live logs:**

```bash
journalctl -u tg-logger -f
```

Useful events to grep for:

```bash
journalctl -u tg-logger -o json | jq 'select(.MESSAGE | fromjson | .event == "delete")'
journalctl -u tg-logger | grep "FloodWait"
journalctl -u tg-logger | grep "media download failed"
```

**Rotate the session** (if it leaks, or to force re-auth):

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

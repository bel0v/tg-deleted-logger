# tg-deleted-logger

Self-hosted Telegram userbot that watches incoming DMs and **forwards every edit and deletion to a Telegram chat you control** — text, photos, voice notes, video, including "view once" media. Two detection paths:

- **Live** — Telegram's `EditedMessage` / `DeletedMessage` push update.
- **Reconciliation** — every 10 minutes the bot diffs its in-memory cache against Telegram's current state and catches anything Telegram silently forgot to notify about.

The local cache lives in RAM only and is purged after 24 hours by default. **Telegram itself is the archive.**

> Built for one-account personal use on a Linux box. Not a packaged product.

## Prerequisites

- Node.js **>= 22** (the systemd unit assumes `/usr/bin/node`)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org) → API development tools
- A Linux box with `systemd` and `nftables` for the production deploy

## Local setup (development)

```bash
git clone https://github.com/bel0v/tg-deleted-logger.git
cd tg-deleted-logger
npm install                # also installs the pre-commit / pre-push hooks
cp .env.example .env       # fill in TG_API_ID and TG_API_HASH
```

Generate a session string interactively (phone + SMS code + 2FA password if set):

```bash
npm run login
```

The script prints a long session string. Paste it into `.env` as `TG_SESSION=...` for local runs.

Smoke-test:

```bash
npm run dev
```

From a second Telegram account, send a DM to the account you logged in with, then edit and delete it. You should see `event=new` → `event=edit` → `event=delete` lines in the dev log, and notifications land in the configured target (Saved Messages by default).

## Notification target

By default, notifications go to **Saved Messages** of the account the userbot is logged in as (`TG_NOTIFY_CHAT_ID=me`). For a cleaner experience, route them to a **dedicated private channel** so they don't mix with real saved content:

1. In Telegram, create a new private channel (the userbot's account as the only member, plus the human reader if different).
2. Make the userbot's account an admin of the channel.
3. Find the channel's numeric ID — Telegram desktop's dev console or a bot like `@username_to_id_bot` works. The value looks like `-1001234567890`.
4. Set `TG_NOTIFY_CHAT_ID=-1001234567890` in `/etc/tg-logger.env`.
5. Restart: `sudo systemctl restart tg-logger`.

## Server deployment

### One-time server setup

Run these as root on a fresh Linux box (Debian/Ubuntu assumed).

**1. Install Node 22 and nftables.**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs nftables
```

**2. Create an unprivileged user and an empty working dir.**

```bash
sudo useradd -r -s /usr/sbin/nologin tglogger
sudo mkdir -p /opt/tg-logger
sudo chown tglogger:tglogger /opt/tg-logger
```

The directory has to exist (so git can clone *into* it) and be empty (so git doesn't refuse). Don't create `data/` yet.

**3. Clone the repo, create the data dir, install deps.**

```bash
sudo -u tglogger git clone https://github.com/bel0v/tg-deleted-logger /opt/tg-logger
cd /opt/tg-logger
sudo -u tglogger mkdir -p data
sudo -u tglogger npm ci
sudo -u tglogger npm run build
```

`data/` holds downloaded media files. The systemd unit's `ReadWritePaths=` directive requires it to exist at service-start time.

**4. Apply the firewall.**

Locks the `tglogger` user's outbound to Telegram DCs + DNS only. Root and the SSH user keep normal outbound so deploys work — see [Applying updates](#applying-updates) below for how the deploy script works around the restriction.

```bash
sudo cp /opt/tg-logger/deploy/firewall.nft /etc/nftables.conf
sudo systemctl enable --now nftables
```

Verify the firewall using bash's built-in `/dev/tcp` (no install needed) — tests TCP reachability without involving TLS:

```bash
# Should print OK — Telegram allowed
sudo -u tglogger timeout 2 bash -c 'exec 3<>/dev/tcp/149.154.167.50/443' && echo OK

# Should print "blocked (good)" — anything else dropped
sudo -u tglogger timeout 2 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo BAD || echo "blocked (good)"
```

**5. Mount the session as an encrypted systemd credential.**

The session string was generated during the local setup above (`npm run login`). On the server:

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
TG_NOTIFY_CHAT_ID=me   # or -1001234567890 for a dedicated private channel
EOF
sudo chmod 600 /etc/tg-logger.env
```

See [`.env.example`](.env.example) for the full list of optional tunables (`TG_MEDIA_DIR`, `TG_RECONCILE_INTERVAL_MS`, `TG_RETENTION_DAYS`, `LOG_LEVEL`) — defaults are sensible, only override if you have a reason.

**7. Install and start the systemd unit.**

```bash
sudo cp /opt/tg-logger/systemd/tg-logger.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-logger
journalctl -u tg-logger -f
```

You should see `connected`, `notifier ready`, `reconcile loop started`, and `retention loop started` within a few seconds.

### Applying updates

To pull the latest code onto a running server, run from a sudo-enabled user (not `tglogger`):

```bash
/opt/tg-logger/scripts/deploy.sh
```

The script runs `git pull --ff-only && npm ci && npm run build` **as root** — because the firewall (step 4) blocks `tglogger` from reaching github.com and `registry.npmjs.org`, and only root has unrestricted outbound. It then `chown -R tglogger:tglogger`s the working dir back so the service can read it, and finally `systemctl restart tg-logger`. It prompts for sudo once and prints `systemctl status` at the end.

Confirm the service came back up cleanly:

```bash
journalctl -u tg-logger -f         # should show "connected" within a few seconds
```

Total downtime is ~5–10 seconds (`systemctl restart` plus the new process reconnecting to Telegram).

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

**View-once media deletion** (the highest-leverage capture case — these are designed by Telegram to vanish):
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

**Rotate the session** (after a suspected leak, or to force re-auth):

1. Generate a new session string in a local checkout: `npm run login`
2. Copy the printed string, then on the server:
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

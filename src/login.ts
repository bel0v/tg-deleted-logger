import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import "dotenv/config"

const apiId = Number(process.env.TG_API_ID)
const apiHash = process.env.TG_API_HASH
if (!Number.isInteger(apiId) || !apiHash) {
	console.error("Set TG_API_ID and TG_API_HASH in .env first")
	process.exit(1)
}

const rl = createInterface({ input: stdin, output: stdout })
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
	connectionRetries: 5,
})

await client.start({
	phoneNumber: () =>
		rl.question("Phone number (international, e.g. +491234567890): "),
	phoneCode: () => rl.question("Code from Telegram: "),
	password: () => rl.question("2FA password: "),
	onError: (err: Error) => {
		console.error(err)
	},
})

console.log("\n--- session string (store via systemd-creds, never commit) ---")
console.log(client.session.save())

rl.close()
await client.disconnect()

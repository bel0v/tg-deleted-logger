import fs from "node:fs"
import "dotenv/config"

export interface Config {
	apiId: number
	apiHash: string
	session: string
}

export function loadConfig(): Config {
	const apiId = Number(process.env.TG_API_ID)
	const apiHash = process.env.TG_API_HASH
	if (!Number.isInteger(apiId) || !apiHash) {
		throw new Error("TG_API_ID and TG_API_HASH must be set")
	}
	return { apiId, apiHash, session: loadSession() }
}

function loadSession(): string {
	const credDir = process.env.CREDENTIALS_DIRECTORY
	if (credDir) {
		return fs.readFileSync(`${credDir}/tg-session`, "utf8").trim()
	}
	const fromEnv = process.env.TG_SESSION
	if (fromEnv) return fromEnv.trim()
	throw new Error(
		"No session found. Run `npm run login` to generate one, then set TG_SESSION (local) or mount via systemd LoadCredentialEncrypted.",
	)
}

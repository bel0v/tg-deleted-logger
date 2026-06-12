import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Api, type TelegramClient } from "telegram"

const MIME_EXT: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"audio/ogg": ".ogg",
	"audio/mpeg": ".mp3",
	"audio/mp4": ".m4a",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"application/pdf": ".pdf",
	"application/x-tgsticker": ".tgs",
}

export function shouldDownload(
	media: Api.TypeMessageMedia | undefined,
): boolean {
	if (!media) return false
	return (
		media instanceof Api.MessageMediaPhoto ||
		media instanceof Api.MessageMediaDocument
	)
}

export function isViewOnce(message: Api.Message): boolean {
	const media = message.media
	if (
		media instanceof Api.MessageMediaPhoto ||
		media instanceof Api.MessageMediaDocument
	) {
		return media.ttlSeconds !== undefined
	}
	return false
}

export function extensionFor(media: Api.TypeMessageMedia): string {
	if (media instanceof Api.MessageMediaPhoto) return ".jpg"
	if (
		media instanceof Api.MessageMediaDocument &&
		media.document instanceof Api.Document
	) {
		return MIME_EXT[media.document.mimeType] ?? ".bin"
	}
	return ".bin"
}

export interface DownloadOptions {
	client: TelegramClient
	message: Api.Message
	mediaDir: string
}

/**
 * Returns the relative filename (under mediaDir) on success, or null if the
 * message has no downloadable media. Throws on download failure.
 */
export async function downloadMessageMedia(
	opts: DownloadOptions,
): Promise<string | null> {
	const { client, message, mediaDir } = opts
	if (!message.media || !shouldDownload(message.media)) return null

	const filename = `${message.id}${extensionFor(message.media)}`
	const fullPath = join(mediaDir, filename)
	mkdirSync(mediaDir, { recursive: true })
	await client.downloadMedia(message, { outputFile: fullPath })
	return filename
}

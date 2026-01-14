import { $ } from "bun";
import { Hono } from "hono";

const app = new Hono();

// Type definitions for yt-dlp subtitle info
interface SubtitleInfo {
	language: string | null;
	subtitles: Record<string, unknown[]>;
	automatic_captions: Record<string, unknown[]>;
}

interface SelectedLanguage {
	lang: string;
	isManual: boolean;
}

// Error class for transcript-specific errors
class TranscriptError extends Error {
	constructor(
		message: string,
		public code: string,
		public statusCode: number = 500,
	) {
		super(message);
		this.name = "TranscriptError";
	}
}

// Validate YouTube URL
function isValidYouTubeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const validHosts = [
			"youtube.com",
			"www.youtube.com",
			"m.youtube.com",
			"youtu.be",
			"www.youtu.be",
		];
		return validHosts.some(
			(host) =>
				parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
		);
	} catch {
		return false;
	}
}

// Extract video ID from YouTube URL
function extractVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);

		// Handle youtu.be short URLs
		if (parsed.hostname.includes("youtu.be")) {
			return parsed.pathname.slice(1).split("/")[0] || null;
		}

		// Handle youtube.com/watch URLs
		if (parsed.pathname === "/watch") {
			return parsed.searchParams.get("v");
		}

		// Handle /v/, /embed/, /shorts/, /live/ URLs
		const pathMatch = parsed.pathname.match(/^\/(v|embed|shorts|live)\/([^/?]+)/);
		if (pathMatch) {
			return pathMatch[2];
		}

		return null;
	} catch {
		return null;
	}
}

// Parse VTT content to plain text
function parseVTT(content: string): string {
	const lines = content.split("\n");
	const textLines: string[] = [];
	let inCue = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip header and empty lines
		if (
			trimmed === "WEBVTT" ||
			trimmed === "" ||
			trimmed.startsWith("Kind:") ||
			trimmed.startsWith("Language:")
		) {
			inCue = false;
			continue;
		}

		// Skip timestamp lines (contain -->)
		if (trimmed.includes("-->")) {
			inCue = true;
			continue;
		}

		// Skip cue identifiers (numeric or NOTE lines)
		if (/^\d+$/.test(trimmed) || trimmed.startsWith("NOTE")) {
			continue;
		}

		// Collect text content
		if (inCue && trimmed) {
			// Remove VTT tags like <c>, </c>, <v speaker>, etc.
			const cleanText = trimmed
				.replace(/<[^>]+>/g, "") // Remove HTML-like tags
				.replace(/&nbsp;/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.trim();

			if (cleanText) {
				textLines.push(cleanText);
			}
		}
	}

	// Deduplicate consecutive identical lines (common in auto-subs)
	const deduplicated = textLines.filter(
		(line, index) => index === 0 || line !== textLines[index - 1],
	);

	return deduplicated.join("\n");
}

// Parse yt-dlp error output
function parseYtDlpError(stderr: string): TranscriptError {
	if (
		stderr.includes("Video unavailable") ||
		stderr.includes("is not a valid URL") ||
		stderr.includes("Incomplete YouTube ID")
	) {
		return new TranscriptError("Video not found", "VIDEO_NOT_FOUND", 404);
	}
	if (stderr.includes("429") || stderr.includes("Too Many Requests")) {
		return new TranscriptError("Rate limited by YouTube", "RATE_LIMITED", 429);
	}
	if (stderr.includes("Private video") || stderr.includes("Sign in")) {
		return new TranscriptError(
			"Video is private or requires authentication",
			"ACCESS_DENIED",
			403,
		);
	}
	return new TranscriptError(`yt-dlp error: ${stderr}`, "UNKNOWN", 500);
}

// Get available subtitles metadata from yt-dlp
async function getAvailableSubtitles(url: string): Promise<SubtitleInfo> {
	const result =
		await $`/usr/local/bin/yt-dlp --skip-download --no-warnings --no-playlist --print "%(.{language,subtitles,automatic_captions})#j" ${url}`
			.nothrow()
			.quiet();

	if (result.exitCode !== 0) {
		throw parseYtDlpError(result.stderr.toString());
	}

	const output = result.stdout.toString().trim();
	const data = JSON.parse(output);

	return {
		language: data.language ?? null,
		subtitles: data.subtitles ?? {},
		automatic_captions: data.automatic_captions ?? {},
	};
}

// Select best available language based on priority
function selectBestLanguage(info: SubtitleInfo): SelectedLanguage | null {
	const { language: originalLang, subtitles, automatic_captions } = info;

	// Filter out non-language entries like "live_chat" that YouTube returns for live streams
	const invalidLangs = ["live_chat"];
	const manualLangs = Object.keys(subtitles).filter(
		(l) => !invalidLangs.includes(l),
	);
	const autoLangs = Object.keys(automatic_captions).filter(
		(l) => !invalidLangs.includes(l),
	);

	// Priority 1: Manual in original language
	if (originalLang && manualLangs.includes(originalLang)) {
		return { lang: originalLang, isManual: true };
	}
	// Priority 2: Manual in English
	const enManual = manualLangs.find((l) => l.startsWith("en"));
	if (enManual) return { lang: enManual, isManual: true };

	// Priority 3: Any manual
	if (manualLangs.length > 0) return { lang: manualLangs[0], isManual: true };

	// Priority 4: Auto in original language
	if (originalLang && autoLangs.includes(originalLang)) {
		return { lang: originalLang, isManual: false };
	}
	// Priority 5: Auto in English
	const enAuto = autoLangs.find((l) => l.startsWith("en"));
	if (enAuto) return { lang: enAuto, isManual: false };

	// Priority 6: Any auto
	if (autoLangs.length > 0) return { lang: autoLangs[0], isManual: false };

	return null;
}

// Get video metadata using yt-dlp
async function getVideoMetadata(videoId: string): Promise<{
	description: string;
	view_count: number;
	author: string;
}> {
	const result =
		await $`/usr/local/bin/yt-dlp --skip-download --no-warnings --no-playlist --print "%(.{description,view_count,uploader})#j" "https://www.youtube.com/watch?v=${videoId}"`
			.nothrow()
			.quiet();

	if (result.exitCode !== 0) {
		throw parseYtDlpError(result.stderr.toString());
	}

	const output = result.stdout.toString().trim();
	const data = JSON.parse(output);

	return {
		description: data.description ?? "",
		view_count: data.view_count ?? 0,
		author: data.uploader ?? "",
	};
}

// Timeout wrapper
async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorMessage: string,
): Promise<T> {
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new TranscriptError(errorMessage, "TIMEOUT", 504)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]);
}

// Find subtitle file in output directory
async function findSubtitleFile(
	outputDir: string,
	videoId: string,
	lang: string,
): Promise<{ path: string; type: "manual" | "auto" } | null> {
	const glob = new Bun.Glob(`${videoId}.${lang}*.vtt`);
	const files: string[] = [];

	for await (const file of glob.scan(outputDir)) {
		files.push(file);
	}

	// Prefer manual subtitles (no .auto. in filename)
	const manualSub = files.find((f) => !f.includes(".auto."));
	if (manualSub) {
		return { path: `${outputDir}/${manualSub}`, type: "manual" };
	}

	// Fall back to auto-generated
	const autoSub = files.find((f) => f.includes(".auto."));
	if (autoSub) {
		return { path: `${outputDir}/${autoSub}`, type: "auto" };
	}

	return null;
}

// Download and parse transcript
async function downloadAndParseTranscript(
	url: string,
	lang?: string,
): Promise<{
	transcript: string;
	videoId: string;
	subtitleType: "manual" | "auto";
	detectedLanguage: string;
	wasAutoDetected: boolean;
	availableLanguages?: string[];
}> {
	const videoId = extractVideoId(url);
	if (!videoId) {
		throw new TranscriptError("Could not extract video ID", "INVALID_URL", 400);
	}

	let targetLang: string;
	let wasAutoDetected = false;
	let availableLanguages: string[] | undefined;

	// Auto-detection logic when lang is not specified or is "auto"
	if (!lang || lang === "auto") {
		const subtitleInfo = await getAvailableSubtitles(url);

		// Collect all available languages for metadata
		availableLanguages = Array.from(
			new Set([
				...Object.keys(subtitleInfo.subtitles),
				...Object.keys(subtitleInfo.automatic_captions),
			]),
		);

		const selected = selectBestLanguage(subtitleInfo);
		if (!selected) {
			throw new TranscriptError(
				"No subtitles available for this video",
				"NO_SUBTITLES",
				404,
			);
		}

		targetLang = selected.lang;
		wasAutoDetected = true;
	} else {
		targetLang = lang;
	}

	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;

	// Create temp directory
	await $`mkdir -p ${outputDir}`;

	try {
		// Execute yt-dlp to download subtitles
		const result = await $`/usr/local/bin/yt-dlp \
      --write-sub \
      --write-auto-sub \
      --sub-lang ${targetLang} \
      --sub-format vtt \
      --skip-download \
      --no-warnings \
      --no-playlist \
      -o "${outputDir}/%(id)s" \
      ${url}`
			.nothrow()
			.quiet();

		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString();
			throw parseYtDlpError(stderr);
		}

		// Find the subtitle file
		const subtitleFile = await findSubtitleFile(outputDir, videoId, targetLang);
		if (!subtitleFile) {
			throw new TranscriptError(
				`No subtitles available for language: ${targetLang}`,
				"NO_SUBTITLES",
				404,
			);
		}

		// Read and parse the subtitle file
		const subtitleContent = await Bun.file(subtitleFile.path).text();
		const transcript = parseVTT(subtitleContent);

		if (!transcript.trim()) {
			throw new TranscriptError("Transcript is empty", "NO_SUBTITLES", 404);
		}

		return {
			transcript,
			videoId,
			subtitleType: subtitleFile.type,
			detectedLanguage: targetLang,
			wasAutoDetected,
			availableLanguages,
		};
	} finally {
		// Cleanup temp directory
		await $`rm -rf ${outputDir}`.nothrow();
	}
}

// Health check endpoint
app.get("/", (c) => c.json({ status: "ok" }));

// Transcript endpoint
app.get("/transcript", async (c) => {
	const url = c.req.query("url");
	const langParam = c.req.query("lang");
	// Treat "auto" or undefined as auto-detection mode
	const lang = langParam === "auto" ? undefined : langParam;

	// Validate URL presence
	if (!url) {
		return c.json(
			{ success: false, error: "URL is required", code: "INVALID_URL" },
			400,
		);
	}

	// Validate YouTube URL
	if (!isValidYouTubeUrl(url)) {
		return c.json(
			{ success: false, error: "Invalid YouTube URL", code: "INVALID_URL" },
			400,
		);
	}

	try {
		console.log({ message: "Downloading transcript" });
		const result = await withTimeout(
			downloadAndParseTranscript(url, lang),
			30000, // 30 second timeout
			"Transcript download timed out",
		);
		console.log({ message: "Downloading transcript", result });

		// Fetch video metadata
		console.log({ message: "Fetching video metadata" });
		const videoMetadata = await withTimeout(
			getVideoMetadata(result.videoId),
			15000, // 15 second timeout for metadata
			"Metadata fetch timed out",
		);
		console.log({ message: "Video metadata", videoMetadata });

		return c.json({
			success: true,
			transcript: result.transcript,
			metadata: {
				videoId: result.videoId,
				subtitleType: result.subtitleType,
				language: result.detectedLanguage,
				wasAutoDetected: result.wasAutoDetected,
				availableLanguages: result.availableLanguages,
				description: videoMetadata.description,
				view_count: videoMetadata.view_count,
				author: videoMetadata.author,
			},
		});
	} catch (error) {
		if (error instanceof TranscriptError) {
			return c.json(
				{ success: false, error: error.message, code: error.code },
				error.statusCode as 400 | 403 | 404 | 429 | 500 | 504,
			);
		}
		console.error("Unexpected error:", error);
		return c.json(
			{ success: false, error: "Internal server error", code: "UNKNOWN" },
			500,
		);
	}
});

export default {
	fetch: app.fetch,
	idleTimeout: 60, // 60 seconds to handle slow yt-dlp operations
};

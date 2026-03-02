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
		const pathMatch = parsed.pathname.match(
			/^\/(v|embed|shorts|live)\/([^/?]+)/,
		);
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
		return new TranscriptError(
			`Video not found: ${stderr.trim()}`,
			"VIDEO_NOT_FOUND",
			404,
		);
	}
	if (stderr.includes("429") || stderr.includes("Too Many Requests")) {
		return new TranscriptError(
			`Rate limited by YouTube: ${stderr.trim()}`,
			"RATE_LIMITED",
			429,
		);
	}
	if (stderr.includes("Private video") || stderr.includes("Sign in")) {
		return new TranscriptError(
			`Video is private or requires authentication: ${stderr.trim()}`,
			"ACCESS_DENIED",
			403,
		);
	}
	return new TranscriptError(`yt-dlp error: ${stderr.trim()}`, "UNKNOWN", 500);
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

// Get the base language code (e.g. "pt-BR" -> "pt", "zh-Hans" -> "zh")
function baseLangCode(lang: string): string {
	return lang.split("-")[0];
}

// Find a language key matching a locale (e.g. "pt-BR" matches "pt")
// Skips "-orig" suffixed keys (handled separately)
function findMatchingLang(langs: string[], target: string): string | undefined {
	// Exact match first
	if (langs.includes(target)) return target;
	// Base language match, but skip "-orig" keys
	const base = baseLangCode(target);
	return langs.find((l) => l === base && !l.endsWith("-orig"));
}

// Select available languages in priority order (best first)
function selectLanguagePriorities(info: SubtitleInfo): SelectedLanguage[] {
	const { language: originalLang, subtitles, automatic_captions } = info;

	// Filter out non-language entries like "live_chat" that YouTube returns for live streams
	const invalidLangs = ["live_chat"];
	const manualLangs = Object.keys(subtitles).filter(
		(l) => !invalidLangs.includes(l),
	);
	const autoLangs = Object.keys(automatic_captions).filter(
		(l) => !invalidLangs.includes(l),
	);

	const results: SelectedLanguage[] = [];
	const seen = new Set<string>();

	const add = (lang: string, isManual: boolean) => {
		const key = `${lang}:${isManual}`;
		if (!seen.has(key)) {
			seen.add(key);
			results.push({ lang, isManual });
		}
	};

	// Priority 1: Manual in original language
	if (originalLang) {
		const match = findMatchingLang(manualLangs, originalLang);
		if (match) add(match, true);
	}
	// Priority 2: Manual in English
	const enManual = manualLangs.find((l) => l.startsWith("en"));
	if (enManual) add(enManual, true);

	// Priority 3: Any manual
	for (const l of manualLangs) add(l, true);

	// Priority 4: Auto in original language using base code (e.g. "pt-BR" -> try "pt")
	// The "-orig" keys in automatic_captions are yt-dlp metadata markers;
	// --sub-lang should use the base language code to get the original (non-translated) subtitle.
	if (originalLang) {
		const base = baseLangCode(originalLang);
		// Add the base code directly — it downloads the original speech-recognized subtitle
		// which doesn't hit YouTube's translation API and is less likely to be rate-limited
		if (autoLangs.some((l) => l === base || l === `${base}-orig`)) {
			add(base, false);
		}
	}
	// Priority 5: Auto in English
	const enAuto = autoLangs.find((l) => l === "en" || l.startsWith("en-") && !l.endsWith("-orig"));
	if (enAuto) add("en", false);

	// Priority 7: Any remaining auto
	for (const l of autoLangs) add(l, false);

	return results;
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

// Find any subtitle file in output directory (language-agnostic)
async function findAnySubtitleFile(
	outputDir: string,
	videoId: string,
): Promise<{ path: string; type: "manual" | "auto"; lang: string } | null> {
	const glob = new Bun.Glob(`${videoId}.*.vtt`);
	const files: string[] = [];

	for await (const file of glob.scan(outputDir)) {
		files.push(file);
	}

	if (files.length === 0) return null;

	// Extract language from filename: {videoId}.{lang}.vtt or {videoId}.{lang}.auto.vtt
	const extractLang = (f: string) => {
		const withoutId = f.replace(`${videoId}.`, "");
		return withoutId.replace(/\.auto\.vtt$/, "").replace(/\.vtt$/, "");
	};

	const manualSub = files.find((f) => !f.includes(".auto."));
	if (manualSub) {
		return {
			path: `${outputDir}/${manualSub}`,
			type: "manual",
			lang: extractLang(manualSub),
		};
	}

	const autoSub = files[0];
	return {
		path: `${outputDir}/${autoSub}`,
		type: "auto",
		lang: extractLang(autoSub),
	};
}

// Try downloading subtitle for a specific language
async function tryDownloadSubtitle(
	url: string,
	videoId: string,
	targetLang: string,
): Promise<{
	transcript: string;
	subtitleType: "manual" | "auto";
}> {
	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;
	await $`mkdir -p ${outputDir}`;

	try {
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

		const subtitleFile = await findSubtitleFile(outputDir, videoId, targetLang);
		if (!subtitleFile) {
			throw new TranscriptError(
				`No subtitles available for language: ${targetLang}`,
				"NO_SUBTITLES",
				404,
			);
		}

		const subtitleContent = await Bun.file(subtitleFile.path).text();
		const transcript = parseVTT(subtitleContent);

		if (!transcript.trim()) {
			throw new TranscriptError("Transcript is empty", "NO_SUBTITLES", 404);
		}

		return { transcript, subtitleType: subtitleFile.type };
	} finally {
		await $`rm -rf ${outputDir}`.nothrow();
	}
}

// Download the original auto-generated subtitle using the video's original language
async function tryDownloadOriginalSubtitle(
	url: string,
	videoId: string,
	originalLang: string,
): Promise<{
	transcript: string;
	subtitleType: "manual" | "auto";
	detectedLanguage: string;
}> {
	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;
	await $`mkdir -p ${outputDir}`;

	// Use the base language code (e.g. "pt-BR" -> "pt") for --sub-lang
	const baseLang = originalLang.split("-")[0];

	try {
		const result = await $`/usr/local/bin/yt-dlp \
      --write-auto-sub \
      --sub-lang ${baseLang} \
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

		const subtitleFile = await findAnySubtitleFile(outputDir, videoId);
		if (!subtitleFile) {
			throw new TranscriptError(
				"No auto-generated subtitles available",
				"NO_SUBTITLES",
				404,
			);
		}

		const subtitleContent = await Bun.file(subtitleFile.path).text();
		const transcript = parseVTT(subtitleContent);

		if (!transcript.trim()) {
			throw new TranscriptError("Transcript is empty", "NO_SUBTITLES", 404);
		}

		return {
			transcript,
			subtitleType: subtitleFile.type,
			detectedLanguage: subtitleFile.lang,
		};
	} finally {
		await $`rm -rf ${outputDir}`.nothrow();
	}
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

	// When a specific language is requested, try it directly (no fallback)
	if (lang && lang !== "auto") {
		const { transcript, subtitleType } = await tryDownloadSubtitle(
			url,
			videoId,
			lang,
		);
		return {
			transcript,
			videoId,
			subtitleType,
			detectedLanguage: lang,
			wasAutoDetected: false,
		};
	}

	// Auto-detection: get available subtitles and try languages in priority order
	const subtitleInfo = await getAvailableSubtitles(url);

	const availableLanguages = Array.from(
		new Set([
			...Object.keys(subtitleInfo.subtitles),
			...Object.keys(subtitleInfo.automatic_captions),
		]),
	);

	const priorities = selectLanguagePriorities(subtitleInfo);
	if (priorities.length === 0) {
		throw new TranscriptError(
			"No subtitles available for this video",
			"NO_SUBTITLES",
			404,
		);
	}

	// Try top priority languages first (max 2 to stay within timeout budget)
	const maxAttempts = Math.min(priorities.length, 2);
	let lastError: TranscriptError | undefined;
	for (let i = 0; i < maxAttempts; i++) {
		const selected = priorities[i];
		try {
			const { transcript, subtitleType } = await tryDownloadSubtitle(
				url,
				videoId,
				selected.lang,
			);
			return {
				transcript,
				videoId,
				subtitleType,
				detectedLanguage: selected.lang,
				wasAutoDetected: true,
				availableLanguages,
			};
		} catch (error) {
			if (
				error instanceof TranscriptError &&
				error.code === "RATE_LIMITED"
			) {
				lastError = error;
				continue;
			}
			throw error;
		}
	}

	// Last resort: download using the video's original language directly.
	// Auto-translated subtitles hit YouTube's translation API which is aggressively rate-limited,
	// but the original language subtitle is pre-generated and more likely to succeed.
	try {
		const result = await tryDownloadOriginalSubtitle(url, videoId, subtitleInfo.language ?? "en");
		return {
			transcript: result.transcript,
			videoId,
			subtitleType: result.subtitleType,
			detectedLanguage: result.detectedLanguage,
			wasAutoDetected: true,
			availableLanguages,
		};
	} catch (error) {
		if (error instanceof TranscriptError && error.code === "RATE_LIMITED") {
			throw error;
		}
		// If this also fails, throw the original rate limit error
		throw (
			lastError ??
			(error instanceof TranscriptError
				? error
				: new TranscriptError(
						"No subtitles available for this video",
						"NO_SUBTITLES",
						404,
					))
		);
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

import { $ } from "bun";
import { Hono } from "hono";

const app = new Hono();

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

		// Handle /v/, /embed/, /shorts/ URLs
		const pathMatch = parsed.pathname.match(/^\/(v|embed|shorts)\/([^/?]+)/);
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
	lang: string,
): Promise<{
	transcript: string;
	videoId: string;
	subtitleType: "manual" | "auto";
}> {
	const videoId = extractVideoId(url);
	if (!videoId) {
		throw new TranscriptError("Could not extract video ID", "INVALID_URL", 400);
	}

	const outputDir = `/tmp/subs/${videoId}_${Date.now()}`;

	// Create temp directory
	await $`mkdir -p ${outputDir}`;

	try {
		// Execute yt-dlp to download subtitles
		const result = await $`/usr/local/bin/yt-dlp \
      --write-sub \
      --write-auto-sub \
      --sub-lang ${lang} \
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
		const subtitleFile = await findSubtitleFile(outputDir, videoId, lang);
		if (!subtitleFile) {
			throw new TranscriptError(
				`No subtitles available for language: ${lang}`,
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
	const lang = c.req.query("lang") ?? "en";

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
		const result = await withTimeout(
			downloadAndParseTranscript(url, lang),
			30000, // 30 second timeout
			"Transcript download timed out",
		);

		return c.json({
			success: true,
			transcript: result.transcript,
			metadata: {
				videoId: result.videoId,
				subtitleType: result.subtitleType,
				language: lang,
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

export default app;

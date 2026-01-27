import { Container, getRandom } from "@cloudflare/containers";
import { sValidator } from "@hono/standard-validator";

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import z from "zod";

const INSTANCE_COUNT = 10;

export class MyContainer extends Container {
	defaultPort = 3000;
	sleepAfter = "5m";
}

function extractVideoId(url: string): string {
	const match = url.match(
		/.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|shorts\/|live\/)([^#&?]*).*/,
	);
	if (match !== null && match[1].length === 11) {
		return match[1];
	} else {
		throw new Error("Failed to get youtube video id from the url");
	}
}

async function loadURLMeta(env: CloudflareBindings, url: string) {
	const params = {
		url: url,
	};
	// Prepare the request to the browser worker
	const searchParams = new URLSearchParams(params);
	const requestUrl = `https://browser-worker.bruce-waynezu.workers.dev/?${searchParams.toString()}`;

	// Read response as text first to avoid deserialization issues
	let text: string | undefined;
	try {
		// @ts-expect-error
		const response = await env.BROWSER_WORKER.internalFetch(
			new Request(requestUrl),
		);

		if (!response.ok) {
			throw new Error(
				`Failed to get URL: ${response.status} ${response.statusText}`,
			);
		}

		// Read response as text first to avoid deserialization issues
		text = await response.text();
		if (!text) {
			text = '[{ "content": { "og_image": "", "title": "" } }]';
		}
		const d: { content: { og_image: string; title: string } }[] =
			JSON.parse(text);
		const content = d[0]?.content || {};

		return {
			thumbnail_url: content.og_image,
			title: content.title,
		};
	} catch (e) {
		console.error({
			message: "Failed to parse metadata response",
			text: text || "No text",
			error: e,
		});
		return {
			thumbnail_url: "",
			title: "",
		};
	}
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Middleware to verify the bearer token
app.use(
	"/*",
	bearerAuth({
		verifyToken: (token, c) => {
			return token === c.env.API_KEY;
		},
	}),
);

const schema = z.object({
	url: z.url(),
	lang: z.string().optional(), // If omitted, container will auto-detect
});

app.get("/", sValidator("query", schema), async (c) => {
	try {
		const { url, lang } = c.req.valid("query");

		// Get a random container instance for load balancing
		const container = await getRandom(c.env.MY_CONTAINER, INSTANCE_COUNT);

		// Build URL with query params
		const transcriptUrl = new URL("/transcript", "http://container");
		transcriptUrl.searchParams.set("url", url);
		// Only set lang if explicitly provided
		if (lang) {
			transcriptUrl.searchParams.set("lang", lang);
		}

		console.log({
			message: "Fetching transcript from container",
			transcriptUrl: transcriptUrl.toString(),
		});
		// Fetch from container
		const response = await container.fetch(transcriptUrl.toString());
		console.log({ message: "Response from container", response });
		const text = await response.text();
		console.log({ message: "Text from container", text });

		// Try to parse as JSON, handle non-JSON responses
		let data: {
			success: boolean;
			transcript: string;
			metadata?: {
				description?: string;
				view_count?: number;
				author?: string;
			};
		};
		try {
			data = JSON.parse(text);
		} catch {
			return c.json(
				{ error: text || "Container returned invalid response" },
				500,
			);
		}

		const { thumbnail_url, title } = await loadURLMeta(c.env, url);
		const metadata: {
			thumbnail_url?: string;
			title: string;
			source: string;
			description?: string;
			view_count?: number;
			author?: string;
		} = {
			source: extractVideoId(url),
			thumbnail_url,
			title,
			description: data.metadata?.description,
			view_count: data.metadata?.view_count,
			author: data.metadata?.author,
		};

		// Return response with same status code
		return c.json(
			{ content: data.transcript, metadata },
			response.status as 200 | 400 | 403 | 404 | 429 | 500 | 504,
		);
	} catch (e) {
		if (e instanceof Error) {
			console.error(e);
			return c.json({ error: e.message }, 500);
		}
		console.error(e);
		return c.json({ error: "Unknown error" }, 500);
	}
});

export default app;

import { Container, getRandom } from "@cloudflare/containers";
import { sValidator } from "@hono/standard-validator";

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import z from "zod";

const INSTANCE_COUNT = 10;

export class MyContainer extends Container {
	defaultPort = 3000;
	sleepAfter = "2h";
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
	lang: z.string().optional().default("en"),
});

app.get("/", sValidator("query", schema), async (c) => {
	try {
		const { url, lang } = c.req.valid("query");

		// Get a random container instance for load balancing
		const container = await getRandom(c.env.MY_CONTAINER, INSTANCE_COUNT);

		// Build URL with query params
		const transcriptUrl = new URL("/transcript", "http://container");
		transcriptUrl.searchParams.set("url", url);
		transcriptUrl.searchParams.set("lang", lang);

		// Fetch from container
		const response = await container.fetch(transcriptUrl.toString());
		const text = await response.text();

		// Try to parse as JSON, handle non-JSON responses
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			return c.json({ error: text || "Container returned invalid response" }, 500);
		}

		// Return response with same status code
		return c.json(data, response.status as 200 | 400 | 403 | 404 | 429 | 500 | 504);
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

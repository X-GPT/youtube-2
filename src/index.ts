import { Container } from "@cloudflare/containers";
import { sValidator } from "@hono/standard-validator";

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import z from "zod";

export class MyContainer extends Container {
	defaultPort = 8080;
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
		console.log({ url, lang });
		return c.json({
			content: "test",
			metadata: { thumbnail_url: "test", title: "test" },
		});
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

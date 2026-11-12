import { expect, test } from "@playwright/test";
import { continuityAuthorityScript } from "./authority.fixture.ts";

type Handler = (request: Request) => Response | Promise<Response>;
function handlerFor(script: string): Handler {
	let selected: Handler | undefined;
	new Function("Bun", "console", script)(
		{
			CryptoHasher: Bun.CryptoHasher,
			serve(options: { fetch: Handler }) {
				selected = options.fetch;
				return { port: 1, stop() {} };
			},
		},
		{ log() {} },
	);
	if (!selected) throw new Error("Authority handler missing");
	return selected;
}

test("continuity authority rotates keys, denies old headers and exposes only IDs @unit", async () => {
	const handler = handlerFor(
		continuityAuthorityScript({
			marker: "WORKSPACE_WITNESS_00000000-0000-4000-8000-000000000000",
			firstPrompt: "before",
			nextPrompt: "after",
		}),
	);
	const post = (path: string, key: string, body: unknown = {}) =>
		handler(
			new Request(`http://127.0.0.1${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${key}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	const first = await (await post("/v1/admin/keys", "fixture-mint")).json();
	expect(
		(await post(`/v1/admin/keys/${first.key_id}/revoke`, "fixture-mint"))
			.status,
	).toBe(200);
	expect(
		(await post("/v1/chat/completions", first.key, { messages: [] })).status,
	).toBe(403);
	const second = await (await post("/v1/admin/keys", "fixture-mint")).json();
	expect(second.key_id).not.toBe(first.key_id);
	expect(second.key).not.toBe(first.key);
	expect(
		(
			await post("/v1/chat/completions", second.key, {
				messages: [{ role: "user", content: "before" }],
			})
		).status,
	).toBe(200);
	const stats = await (
		await handler(new Request("http://127.0.0.1/fixture-stats"))
	).json();
	expect(stats.keys[0].active).toBe(false);
	expect(stats.keys[1].active).toBe(true);
	expect(stats.keys[0].revokedSequence).toBeLessThan(
		stats.keys[1].issuedSequence,
	);
	expect(JSON.stringify(stats)).not.toContain(first.key);
	expect(JSON.stringify(stats)).not.toContain(second.key);
});

import { expect, test } from "@playwright/test";
import { ConnectionSchema } from "../src/settings.connections.ts";

test("the operator template validates without embedding any issued credential", async () => {
	const { SettingsSchema } = await import("../src/settings.schema.ts");
	const doc = await Bun.file(
		new URL("../../../settings.template.json", import.meta.url),
	).json();
	expect(SettingsSchema.safeParse(doc).success).toBe(true);
	for (const entry of Object.values(doc.providers))
		expect(JSON.stringify(entry)).not.toMatch(/bksk_|sk-[A-Za-z0-9]|ghp_/);
});

test("native audio providers need no invented OpenAI endpoint", () => {
	const parsed = ConnectionSchema.parse({
		kind: "provider",
		provider: "elevenlabs",
		adapter: "elevenlabs",
		protocol: "native",
		endpoints: { base: "https://api.elevenlabs.io" },
		auth: { kind: "inline", key: "fixture-audio-value" },
	});
	expect(parsed.endpoints).toEqual({ base: "https://api.elevenlabs.io" });
	expect(parsed).not.toHaveProperty("endpoints.openai");
});

test("a keyless Buckle peer has a local wildcard and no invented account capacity", () => {
	const parsed = ConnectionSchema.parse({
		kind: "buckle",
		adapter: "buckle",
		endpoints: { openai: "http://peer.example/v1" },
	});
	expect(parsed).toMatchObject({
		allowed_models: ["*"],
		discovery: { enabled: true },
	});
	expect(parsed).not.toHaveProperty("account");
	expect(parsed).not.toHaveProperty("auth");
});

test("provider account pressure and relay connection limits are independent", () => {
	const parsed = ConnectionSchema.parse({
		kind: "provider",
		provider: "example",
		adapter: "openai",
		endpoints: {
			openai: "https://api.example/v1",
			anthropic: "https://api.example/anthropic",
		},
		auth: { kind: "inline", key: "fixture-private-value" },
		transport: { max_connections: 12 },
		account: { id: "subscription-one", concurrency: 2, queue_limit: 5 },
	});
	expect(parsed).toMatchObject({
		transport: { max_connections: 12 },
		account: { concurrency: 2, queue_limit: 5 },
	});
});

test("peers refuse upstream account pressure and unrelated adapter settings", () => {
	for (const extra of [
		{ account: { id: "foreign", concurrency: 99 } },
		{ adapter: "anthropic" },
	])
		expect(
			ConnectionSchema.safeParse({
				kind: "buckle",
				adapter: "buckle",
				endpoints: { openai: "http://peer.example/v1" },
				...extra,
			}).success,
		).toBe(false);
});

test("auth sources are exclusive and explicit while output env is separate", () => {
	const base = {
		kind: "provider",
		provider: "example",
		adapter: "openai",
		endpoints: { openai: "https://api.example/v1" },
		env: "GENERATED_KEY",
	};
	for (const auth of [
		{ kind: "inline", key: "fixture-value" },
		{ kind: "file", path: "/run/private/provider.env", key_name: "SOURCE_KEY" },
		{ kind: "env", name: "SOURCE_KEY" },
	])
		expect(ConnectionSchema.parse({ ...base, auth })).toMatchObject({
			auth,
			env: "GENERATED_KEY",
		});
	expect(
		ConnectionSchema.safeParse({
			...base,
			auth: { kind: "inline", key: "fixture", path: "/run/other" },
		}).success,
	).toBe(false);
	for (const key of [
		"",
		" ",
		"value\nINJECTED=value",
		"value\r",
		"value\0",
		"valueé",
	])
		expect(
			ConnectionSchema.safeParse({ ...base, auth: { kind: "inline", key } })
				.success,
		).toBe(false);
});

test("URL and model policy refuse credential smuggling and impossible defaults", () => {
	const base = {
		kind: "buckle",
		adapter: "buckle",
		endpoints: { openai: "http://peer.example/v1" },
	};
	for (const openai of [
		"file:///etc/passwd",
		"https://user:secret@example/v1",
		"https://example/v1?key=secret",
		"https://example/v1#secret",
		"http://",
	])
		expect(
			ConnectionSchema.safeParse({ ...base, endpoints: { openai } }).success,
		).toBe(false);
	for (const extra of [
		{ protocol: "anthropic" },
		{ default_model: "other", allowed_models: ["selected"] },
		{ allowed_models: ["*", "selected"] },
		{ allowed_models: ["selected", "selected"] },
	])
		expect(ConnectionSchema.safeParse({ ...base, ...extra }).success).toBe(
			false,
		);
	expect(
		ConnectionSchema.parse({
			...base,
			default_model: "selected",
			allowed_models: ["selected"],
		}).default_model,
	).toBe("selected");
});

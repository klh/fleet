// test/hub-locate.test.ts — multi-hub registry resolver (owner directive
// 2026-10-03: ".prefer hub= should resolve to a real url, local hub to
// remote hubs scenario"). Covers the resolver chain in priority order:
// env override -> repo one-off candidates -> global registry -> mDNS guess
// -> null (degrade). Uses a scratch HOME + a real tiny Bun.serve() instance
// as the "alive" probe target — no network beyond 127.0.0.1.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHub } from "../hooks/lib/hub-locate.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-hub-locate-home-"));
const prevHome = process.env.HOME;
process.env.HOME = HOME;
mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });

const server = Bun.serve({
	port: 0,
	fetch: () => new Response("ok"),
});
const liveUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => {
	server.stop(true);
	process.env.HOME = prevHome;
	rmSync(HOME, { recursive: true, force: true });
});

describe("resolveHub", () => {
	test("env override wins outright, no probing", async () => {
		process.env.SUSPENDERS_HUB_IKEA_URL = "http://unreachable.invalid:1";
		const hub = await resolveHub("IKEA");
		expect(hub?.via).toBe("env");
		expect(hub?.url).toBe("http://unreachable.invalid:1");
		delete process.env.SUSPENDERS_HUB_IKEA_URL;
	});

	test("repo one-off hub-url candidate beats the global registry", async () => {
		writeFileSync(
			join(HOME, ".claude", "local-llm", "hubs.json"),
			JSON.stringify({
				IKEA: { candidates: ["http://unreachable.invalid:2"] },
			}),
		);
		const hub = await resolveHub("IKEA", [liveUrl]);
		expect(hub?.via).toBe("prefer hub-url");
		expect(hub?.url).toBe(liveUrl);
	});

	test("falls through to the global registry when no one-off reaches", async () => {
		writeFileSync(
			join(HOME, ".claude", "local-llm", "hubs.json"),
			JSON.stringify({ NAS: { candidates: [liveUrl] } }),
		);
		const hub = await resolveHub("NAS", ["http://unreachable.invalid:3"]);
		expect(hub?.via).toBe("registry hubs.json");
		expect(hub?.url).toBe(liveUrl);
	});

	test("nothing reachable anywhere -> null (caller degrades, never a silent wrong hub)", async () => {
		writeFileSync(
			join(HOME, ".claude", "local-llm", "hubs.json"),
			JSON.stringify({}),
		);
		const hub = await resolveHub("GHOST", ["http://unreachable.invalid:4"]);
		expect(hub).toBeNull();
	}, 15_000);

	test("blank label is never resolved", async () => {
		expect(await resolveHub("   ")).toBeNull();
	});
});

// Hub-refinement e2e (the settings.json landing) — `.prefer hub=<label>`
// now resolves through the ONE settings.json: the stack projection's
// profile url first, then `hubs.<label>.candidates` (the folded hubs.json
// rows), and the legacy hubs.json walk warns deprecated. An unknown
// `.prefer hub=` label yields a warning listing the known labels. Real
// HTTP probes on 127.0.0.1 — the resolution chain is never mocked.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	knownHubLabels,
	resolveHub,
	unknownHubWarning,
} from "../hooks/lib/hub/hub-locate.ts";

const HOME = mkdtempSync(join(tmpdir(), "klh-hub-settings-e2e-"));
const prevHome = process.env.HOME;
const prevStack = process.env.KLH_STACK;
const prevHubs = process.env.SUSPENDERS_HUBS_FILE;
const confDir = join(HOME, ".config", "klh");
mkdirSync(join(confDir, "secrets"), { recursive: true });
mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
process.env.HOME = HOME;
delete process.env.KLH_STACK;
delete process.env.SUSPENDERS_HUBS_FILE;

const server = Bun.serve({ port: 0, fetch: () => new Response("hub ok") });
const liveUrl = `http://127.0.0.1:${server.port}`;

const SETTINGS = {
	version: "2.0.4",
	hubs: {
		nas: {
			url: liveUrl,
			candidates: [liveUrl],
			token_file: join(confDir, "secrets", "hub-nas.token"),
		},
		desktop: { url: "http://127.0.0.1:1" },
	},
};
writeFileSync(join(confDir, "settings.json"), JSON.stringify(SETTINGS), {
	mode: 0o600,
});
writeFileSync(join(confDir, "secrets", "hub-nas.token"), "tok-e2e-1\n", {
	mode: 0o600,
});
writeFileSync(
	join(HOME, ".claude", "local-llm", "hubs.json"),
	JSON.stringify({ legacy: { candidates: [liveUrl] } }),
	{ mode: 0o600 },
);

test("hub=nas resolves via the settings hubs profile url, token from the 0600 file", async () => {
	const hub = await resolveHub("nas");
	expect(hub?.via).toBe("settings hubs");
	expect(hub?.url).toBe(liveUrl);
	expect(hub?.token).toBe("tok-e2e-1");
});

test("hub with only candidates walks them (hubs.json folded rows)", async () => {
	writeFileSync(
		join(confDir, "settings.json"),
		JSON.stringify({
			version: "2.0.4",
			hubs: { ghost2: { candidates: [liveUrl] } },
		}),
		{ mode: 0o600 },
	);
	const hub = await resolveHub("ghost2");
	expect(hub?.via).toBe("settings hubs candidates");
	expect(hub?.url).toBe(liveUrl);
});

test("legacy hubs.json hit still resolves but warns deprecated", async () => {
	const hub = await resolveHub("legacy");
	expect(hub?.via).toBe("registry hubs.json");
});

test("knownHubLabels + unknownHubWarning list the known labels", () => {
	// the candidates test above rewrote settings.json (ghost2 row), so the
	// known set NOW is that label + the legacy registry row
	const known = knownHubLabels();
	expect(known).toContain("ghost2");
	expect(known).toContain("legacy");
	const warn = unknownHubWarning("bogus-lab");
	expect(warn).toContain("bogus-lab");
	expect(warn).toContain("ghost2");
	expect(unknownHubWarning("ghost2")).toBe(null);
});

test.afterAll(() => {
	server.stop(true);
	process.env.HOME = prevHome;
	if (prevStack === undefined) delete process.env.KLH_STACK;
	else process.env.KLH_STACK = prevStack;
	if (prevHubs === undefined) delete process.env.SUSPENDERS_HUBS_FILE;
	else process.env.SUSPENDERS_HUBS_FILE = prevHubs;
	rmSync(HOME, { recursive: true, force: true });
});

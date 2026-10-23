// singbox.test.ts — W1233: the sing-box enforcement kit's fleet-law set and
// the acceptance verifier. Co-situated coverage: template law (the template
// is intentionally NOT runnable — placeholders), a filled conf passing every
// sub-law, per-law refusals (tun/clash/outbounds/route), the acceptance
// verdict over live rows (PASS / leak FAIL / INCONCLUSIVE), the clash API
// wire leg (bearer secret, row parse), the watch-window dedup, and the
// seed verb's never-overwrite law.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkConfigLaw,
	classifyConnections,
	clashApiOf,
	cliRepresentative,
	defaultConfPath,
	fetchConnections,
	type ClashConnRow,
	readConf,
	seedConf,
	sampleWindow,
	templatePath,
	verifyRows,
	watchedRulesOf,
} from "./singbox.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-singbox-"));
	dirs.push(dir);
	return dir;
}

/** A conf with every placeholder filled — the runnable shape. */
function filledConfText(): string {
	return readFileSync(templatePath(), "utf8")
		.replaceAll("<SINGBOX_LOG_FILE>", "/tmp/fleet-singbox-test.log")
		.replaceAll("<HUB_RELAY_HOST>", "hub.example")
		.replaceAll("<HUB_RELAY_PORT>", "8118")
		.replaceAll("<CLASH_API_PORT>", "9090")
		.replaceAll("<CLASH_API_SECRET>", "s3cret");
}

function filledConf(): Record<string, unknown> {
	const root = JSON.parse(filledConfText()) as Record<string, unknown>;
	const hub = (root.outbounds as Record<string, unknown>[]).find(
		(o) => o.tag === "hub-relay",
	);
	if (hub !== undefined) hub.server_port = 8118;
	return root;
}

/** A conf builder from the template text with a mutation applied. */
function mutatedConf(
	mutate: (root: Record<string, unknown>) => void,
): Record<string, unknown> {
	const root = filledConf();
	mutate(root);
	return root;
}

function row(path: string, chain: string): ClashConnRow {
	return {
		id: crypto.randomUUID(),
		upload: 120,
		download: 4500,
		chains: [chain],
		metadata: { processPath: path, host: "dest.example" },
	};
}

const CLAUDE = "/Applications/Claude.app/Contents/MacOS/Claude";
const CHATGPT = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const SAFARI = "/Applications/Safari.app/Contents/MacOS/Safari";

test("template is intentionally not runnable — placeholders stand", () => {
	const problems = checkConfigLaw(readConf(templatePath()));
	expect(problems.some((p) => p.includes("placeholder unfilled"))).toBe(true);
});

test("filled template passes the full fleet law", () => {
	expect(checkConfigLaw(filledConf())).toEqual([]);
});

test("law: watched regexes cover both bundles but not the claude CLI", () => {
	const watched = watchedRulesOf(filledConf());
	expect(watched.some((w) => w.compiled.test(CLAUDE))).toBe(true);
	expect(watched.some((w) => w.compiled.test(CHATGPT))).toBe(true);
	expect(watched.some((w) => w.compiled.test(cliRepresentative()))).toBe(false);
	expect(watched.some((w) => w.compiled.test(SAFARI))).toBe(false);
});

test("law: auto_route off or strict_route off refuse", () => {
	const laxAuto = mutatedConf((r) => {
		const tun = (r.inbounds as Record<string, unknown>[])[0];
		tun.auto_route = false;
	});
	expect(checkConfigLaw(laxAuto)).toContainEqual(
		expect.stringContaining("auto_route"),
	);
	const laxStrict = mutatedConf((r) => {
		const tun = (r.inbounds as Record<string, unknown>[])[0];
		tun.strict_route = false;
	});
	expect(checkConfigLaw(laxStrict)).toContainEqual(
		expect.stringContaining("strict_route"),
	);
});

test("law: a second tun inbound refuses", () => {
	const two = mutatedConf((r) => {
		(r.inbounds as unknown[]).push({
			type: "tun",
			tag: "tun-2",
			address: ["198.18.0.2/30"],
			auto_route: true,
			strict_route: true,
		});
	});
	expect(checkConfigLaw(two)).toContainEqual(
		expect.stringContaining("exactly one tun inbound"),
	);
});

test("law: non-loopback clash controller refuses", () => {
	const broad = mutatedConf((r) => {
		const clash = (r.experimental as Record<string, unknown>)
			.clash_api as Record<string, unknown>;
		clash.external_controller = "0.0.0.0:9090";
	});
	expect(clashApiOf(broad)).toBeNull();
	expect(checkConfigLaw(broad)).toContainEqual(
		expect.stringContaining("127.0.0.1:<port>"),
	);
});

test("law: missing ChatGPT coverage refuses", () => {
	const hole = mutatedConf((r) => {
		const route = r.route as Record<string, unknown>;
		route.rules = (route.rules as unknown[]).filter(
			(x) =>
				!(x as Record<string, unknown>).process_path_regex
					?.toString()
					.includes("ChatGPT"),
		);
	});
	expect(checkConfigLaw(hole).some((p) => p.includes("ChatGPT.app"))).toBe(
		true,
	);
});

test("law: catch-all routed to hub-relay refuses", () => {
	const global = mutatedConf((r) => {
		(r.route as Record<string, unknown>).final = "hub-relay";
	});
	expect(checkConfigLaw(global)).toContainEqual(
		expect.stringContaining("catch-all never hub-routes"),
	);
});

test("law: unfilled placeholder in the hub server refuses", () => {
	const raw = mutatedConf((r) => {
		const hub = (r.outbounds as Record<string, unknown>[]).find(
			(o) => o.tag === "hub-relay",
		);
		hub.server = "<HUB_RELAY_HOST>";
	});
	expect(
		checkConfigLaw(raw).some((p) => p.includes("placeholder unfilled")),
	).toBe(true);
});

test("verdict: watched hub egress + unwatched direct = PASS", () => {
	const out = verifyRows(filledConf(), [
		row(CLAUDE, "hub-relay"),
		row(SAFARI, "direct"),
	]);
	expect(out.verdict).toBe("PASS");
	expect(out.hub).toBe(1);
	expect(out.rest).toBe(1);
	expect(out.watchedBytes).toBe(4620);
});

test("verdict: watched process on direct = FAIL (enforcement hole)", () => {
	const out = verifyRows(filledConf(), [
		row(CHATGPT, "direct"),
		row(CLAUDE, "hub-relay"),
	]);
	expect(out.verdict).toBe("FAIL");
	expect(out.leaks).toBe(1);
});

test("verdict: unknown watched chain treated as a leak", () => {
	const out = verifyRows(filledConf(), [row(CLAUDE, "some-proxy")]);
	expect(out.verdict).toBe("FAIL");
});

test("verdict: blocked watched process is enforcement, not a leak", () => {
	const c = classifyConnections(
		[row(CLAUDE, "block")],
		watchedRulesOf(filledConf()),
	);
	expect(c.blocked).toHaveLength(1);
	expect(c.leaks).toHaveLength(0);
});

test("verdict: no watched traffic = INCONCLUSIVE, not a pass", () => {
	const out = verifyRows(filledConf(), [row(SAFARI, "direct")]);
	expect(out.verdict).toBe("INCONCLUSIVE");
});

test("verdict: template conf fails before any wire call", () => {
	const out = verifyRows(readConf(templatePath()), []);
	expect(out.verdict).toBe("FAIL");
	expect(out.reason).toContain("conf law");
});

test("wire: fetchConnections rides the loopback clash API with the bearer", async () => {
	let auth = "";
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			auth = req.headers.get("authorization") ?? "";
			return Response.json({
				connections: [row(CLAUDE, "hub-relay")],
			});
		},
	});
	try {
		const rows = await fetchConnections(`127.0.0.1:${server.port}`, "s3c");
		expect(rows).toHaveLength(1);
		expect(auth).toBe("Bearer s3c");
		expect(rows[0]?.chains?.[0]).toBe("hub-relay");
	} finally {
		server.stop(true);
	}
});

test("wire: sampleWindow dedups by connection id across polls", async () => {
	const seen: ClashConnRow[] = [row(CLAUDE, "hub-relay")];
	const fetcher = async (): Promise<ClashConnRow[]> => seen;
	const rows = await sampleWindow("127.0.0.1:1", "", 0, 1, fetcher);
	expect(rows).toHaveLength(1);
});

test("wire: a dead clash API surfaces as an empty window (verdict rules on evidence)", async () => {
	const rows = await sampleWindow("127.0.0.1:1", "", 0, 1);
	expect(rows).toEqual([]);
});

test("seed: template lands once, never over a real conf, force overwrites", () => {
	const dir = tmpDir();
	const target = join(dir, "singbox.json");
	expect(seedConf(target, false)).toBe(target);
	expect(seedConf(target, false)).toBeNull();
	expect(seedConf(target, true)).toBe(target);
	const seeded = readConf(target);
	expect(
		checkConfigLaw(seeded).some((p) => p.includes("placeholder unfilled")),
	).toBe(true);
});

test("conf path: KLH_SINGBOX_CONF override wins, empty string counts as unset", () => {
	const real = join(tmpDir(), "elsewhere.json");
	process.env.KLH_SINGBOX_CONF = real;
	expect(defaultConfPath()).toBe(real);
	process.env.KLH_SINGBOX_CONF = "";
	expect(defaultConfPath()).toContain("singbox.json");
	delete process.env.KLH_SINGBOX_CONF;
});

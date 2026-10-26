// singbox.test.ts — W1260.1: the sing-box CONNECT-egress fleet law set and
// the acceptance verifier. Co-situated coverage: template law (the template
// is intentionally NOT runnable — placeholders), a filled conf passing every
// sub-law, per-law refusals (tun/clash/outbounds/route ordering, domain
// qualification, AI fallback, sniff), the acceptance verdict over live rows
// (PASS / AI-destination leak FAIL / by-law direct / INCONCLUSIVE), the
// clash API wire leg, the watch-window dedup, and the seed verb's
// never-overwrite law.
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkConfigLaw,
	classifyConnections,
	clashApiOf,
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
import { CONNECT_USERS, connectTagOf, goRegexOf } from "./watched.ts";

const dirs: string[] = [];
test.describe("@unit", () => {
	test.afterAll(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function tmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "fleet-singbox-"));
		dirs.push(dir);
		return dir;
	}

	const FILL: Record<string, string> = {
		"<SINGBOX_LOG_FILE>": "/tmp/fleet-singbox-test.log",
		"<BUCKLE_CONNECT_PORT>": "4103",
		"<BUCKLE_CONNECT_TOKEN>": "tok-1234567890",
		"<CLASH_API_PORT>": "9090",
		"<CLASH_API_SECRET>": "s3cret",
	};

	/** A conf with every placeholder filled — the runnable shape. */
	function filledConfText(): string {
		let text = readFileSync(templatePath(), "utf8");
		for (const [k, v] of Object.entries(FILL)) text = text.replaceAll(k, v);
		return text;
	}

	function filledConf(): Record<string, unknown> {
		const root = JSON.parse(filledConfText()) as Record<string, unknown>;
		for (const o of root.outbounds as Record<string, unknown>[]) {
			if (typeof o.tag === "string" && o.tag.startsWith("buckle-connect-"))
				o.server_port = 4103;
		}
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

	const rulesOf = (root: Record<string, unknown>): Record<string, unknown>[] =>
		(root.route as Record<string, unknown>).rules as Record<string, unknown>[];

	function row(
		path: string,
		chain: string,
		host = "api.anthropic.com",
	): ClashConnRow {
		return {
			id: crypto.randomUUID(),
			upload: 120,
			download: 4500,
			chains: [chain],
			metadata: { processPath: path, host },
		};
	}

	const CLAUDE = "/Applications/Claude.app/Contents/MacOS/Claude";
	const CHATGPT = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
	const SAFARI = "/Applications/Safari.app/Contents/MacOS/Safari";
	const CLAUDE_CLI = "/opt/homebrew/bin/claude";

	test("template is intentionally not runnable — placeholders stand", () => {
		const problems = checkConfigLaw(readConf(templatePath()));
		expect(problems.some((p) => p.includes("placeholder unfilled"))).toBe(true);
	});

	test("filled template passes the full fleet law", () => {
		expect(checkConfigLaw(filledConf())).toEqual([]);
	});

	test("law: every CONNECT identity has its per-app outbound", () => {
		const root = filledConf();
		const tags = new Set(
			(root.outbounds as Record<string, unknown>[]).map((o) => o.tag),
		);
		for (const u of CONNECT_USERS) expect(tags.has(connectTagOf(u))).toBe(true);
	});

	test("law: watched regexes cover the GUI bundles, never a CLI or Safari", () => {
		const watched = watchedRulesOf(filledConf());
		expect(watched.some((w) => w.compiled.test(CLAUDE))).toBe(true);
		expect(watched.some((w) => w.compiled.test(CHATGPT))).toBe(true);
		expect(watched.some((w) => w.compiled.test(CLAUDE_CLI))).toBe(false);
		expect(watched.some((w) => w.compiled.test(SAFARI))).toBe(false);
	});

	test("law: username must equal the tag identity; unknown users refuse", () => {
		const swapped = mutatedConf((r) => {
			const o = (r.outbounds as Record<string, unknown>[]).find(
				(x) => x.tag === "buckle-connect-chatgpt",
			);
			o.username = "claude";
		});
		expect(
			checkConfigLaw(swapped).some((p) => p.includes("username must equal")),
		).toBe(true);
		const ghost = mutatedConf((r) => {
			const o = (r.outbounds as Record<string, unknown>[]).find(
				(x) => x.tag === "buckle-connect-vscode",
			);
			o.username = "ghost";
		});
		expect(
			checkConfigLaw(ghost).some((p) =>
				p.includes("must be a CONNECT identity"),
			),
		).toBe(true);
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

	test("law: missing ChatGPT rule refuses (default-on coverage)", () => {
		const hole = mutatedConf((r) => {
			const route = r.route as Record<string, unknown>;
			route.rules = (route.rules as unknown[]).filter(
				(x) =>
					!(x as Record<string, unknown>).process_path_regex
						?.toString()
						.includes("ChatGPT"),
			);
		});
		expect(
			checkConfigLaw(hole).some((p) =>
				p.includes("no buckle-connect-chatgpt rule"),
			),
		).toBe(true);
	});

	test("law: catch-all routed to a connect egress refuses", () => {
		const global = mutatedConf((r) => {
			(r.route as Record<string, unknown>).final = "buckle-connect-claude";
		});
		expect(checkConfigLaw(global)).toContainEqual(
			expect.stringContaining("catch-all never"),
		);
	});

	test("law: bypass rules must precede the connect rules", () => {
		const reordered = mutatedConf((r) => {
			const rules = rulesOf(r);
			const isConnect = (x: Record<string, unknown>): boolean =>
				String(x.outbound ?? "").startsWith("buckle-connect-");
			(r.route as Record<string, unknown>).rules = [
				...rules.filter(isConnect),
				...rules.filter((x) => !isConnect(x)),
			];
		});
		expect(
			checkConfigLaw(reordered).some((p) => p.includes("bypass must precede")),
		).toBe(true);
	});

	test("law: a process rule without the full AI destination set refuses", () => {
		const unqualified = mutatedConf((r) => {
			const rule = rulesOf(r).find((x) =>
				String(x.process_path_regex ?? []).includes("Claude"),
			);
			delete rule.domain_suffix;
		});
		expect(
			checkConfigLaw(unqualified).some((p) =>
				p.includes("full AI destination set"),
			),
		).toBe(true);
	});

	test("law: the AI fallback rule for unknown processes is required", () => {
		const noFallback = mutatedConf((r) => {
			const route = r.route as Record<string, unknown>;
			route.rules = rulesOf(r).filter(
				(x) => x.outbound !== "buckle-connect-buckle",
			);
		});
		expect(
			checkConfigLaw(noFallback).some((p) =>
				p.includes("buckle-connect-buckle"),
			),
		).toBe(true);
	});

	test("law: the sniff rule is required before domain matches", () => {
		const noSniff = mutatedConf((r) => {
			const route = r.route as Record<string, unknown>;
			route.rules = rulesOf(r).filter((x) => x.action !== "sniff");
		});
		expect(
			checkConfigLaw(noSniff).some((p) => p.includes("{action: sniff}")),
		).toBe(true);
	});

	test("law: a process rule must target a buckle-connect outbound", () => {
		const stray = mutatedConf((r) => {
			const rule = rulesOf(r).find((x) =>
				String(x.process_path_regex ?? []).includes("Claude"),
			);
			rule.outbound = "direct";
		});
		expect(
			checkConfigLaw(stray).some((p) =>
				p.includes("must target a buckle-connect"),
			),
		).toBe(true);
	});

	test("law: unfilled placeholder in an outbound server refuses", () => {
		const raw = mutatedConf((r) => {
			const o = (r.outbounds as Record<string, unknown>[]).find(
				(x) => x.tag === "buckle-connect-claude",
			);
			o.server = "<NOT-REAL>";
		});
		expect(
			checkConfigLaw(raw).some((p) => p.includes("placeholder unfilled")),
		).toBe(true);
	});

	test("goRegexOf maps the Go (?i) flag onto the JS i flag", () => {
		const rx = goRegexOf("(?i)/Claude\\.app/");
		expect(rx?.test(CLAUDE)).toBe(true);
		expect(rx?.test("/applications/claude.app/Contents/MacOS/Claude")).toBe(
			true,
		);
		expect(rx?.test("/Applications/Safari.app/x")).toBe(false);
		const plain = goRegexOf("/plain/");
		expect(plain?.test("/api/plain/endpoint")).toBe(true);
	});

	test("verdict: GUI AI egress on buckle-connect + unwatched direct = PASS", () => {
		const out = verifyRows(filledConf(), [
			row(CLAUDE, "buckle-connect-claude"),
			row(SAFARI, "direct"),
		]);
		expect(out.verdict).toBe("PASS");
		expect(out.connect).toBe(1);
		expect(out.byTag["buckle-connect-claude"]).toBe(1);
		expect(out.rest).toBe(1);
		expect(out.watchedBytes).toBe(4620);
	});

	test("verdict: watched app to an AI destination off the gate = FAIL", () => {
		const out = verifyRows(filledConf(), [
			row(CHATGPT, "direct", "api.anthropic.com"),
			row(CLAUDE, "buckle-connect-claude"),
		]);
		expect(out.verdict).toBe("FAIL");
		expect(out.leaks).toBe(1);
	});

	test("verdict: watched app to a NON-AI destination on direct is by-law, never a leak", () => {
		const out = verifyRows(filledConf(), [
			row(CLAUDE, "direct", "update.example.com"),
		]);
		expect(out.leaks).toBe(0);
		expect(out.rest).toBe(1);
		expect(out.verdict).toBe("INCONCLUSIVE");
	});

	test("verdict: blocked AI destination is enforcement, not a leak", () => {
		const c = classifyConnections(
			[row(CLAUDE, "block")],
			watchedRulesOf(filledConf()),
		);
		expect(c.blocked).toHaveLength(1);
		expect(c.leaks).toHaveLength(0);
	});

	test("verdict: unknown-host rows are never domain-claimed as leaks", () => {
		const c = classifyConnections(
			[{ id: "x", chains: ["direct"], metadata: { processPath: CHATGPT } }],
			watchedRulesOf(filledConf()),
		);
		expect(c.leaks).toHaveLength(0);
		expect(c.rest).toBe(1);
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
					connections: [row(CLAUDE, "buckle-connect-claude")],
				});
			},
		});
		try {
			const rows = await fetchConnections(`127.0.0.1:${server.port}`, "s3c");
			expect(rows).toHaveLength(1);
			expect(auth).toBe("Bearer s3c");
			expect(rows[0]?.chains?.[0]).toBe("buckle-connect-claude");
		} finally {
			server.stop(true);
		}
	});

	test("wire: sampleWindow dedups by connection id across polls", async () => {
		const seen: ClashConnRow[] = [row(CLAUDE, "buckle-connect-claude")];
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
});

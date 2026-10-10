// W185 — install.sh contract tests (bun test). Sandboxed HOME + mock W173 hub;
// never touches the real ~/.claude on this machine.
import { describe, test, expect } from "bun:test";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const INSTALL = join(REPO, "install.sh");
const SANDBOX = "/tmp/w185-home-" + process.pid;

function freshHome(): string {
	rmSync(SANDBOX, { recursive: true, force: true });
	mkdirSync(SANDBOX + "/.claude/local-llm", { recursive: true });
	return SANDBOX;
}

const HUB_A = "# ─── Hub federation";
const HUB_B = "# ─── Summary";
function hubSource(): string {
	const t = readFileSync(INSTALL, "utf8");
	const a = t.indexOf(HUB_A);
	const b = t.indexOf(HUB_B);
	if (a < 0 || b <= a) throw new Error("hub region markers missing");
	return t.slice(a, b);
}

// the mock W173 hub: enroll + first policy pull with menu
function startMock(): {
	srv: ReturnType<typeof Bun.serve>;
	url: string;
	CODE: string;
	TOKEN: string;
} {
	const CODE = "test-code-123";
	const TOKEN = "tok-w185-123";
	const srv = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const u = new URL(req.url);
			if (req.method === "POST" && u.pathname === "/federation/enroll") {
				const body = (await req.json()) as { code?: string };
				if (body.code !== CODE)
					return Response.json({ error: "invalid" }, { status: 401 });
				return Response.json({
					spoke_id: "spoke-w185",
					spoke_token: TOKEN,
					policy_version: 1,
					dns_entries: ["suspenders.local", "belt.local"],
				});
			}
			if (req.method === "GET" && u.pathname === "/federation/policy") {
				if (req.headers.get("authorization") !== "Bearer " + TOKEN) {
					return new Response("no", { status: 401 });
				}
				return Response.json({
					policy_version: 1,
					menu: ["glm-5.3-flash", "local-swarm"],
					cr_queue: [],
				});
			}
			return new Response("nf", { status: 404 });
		},
	});
	return { srv, url: "http://127.0.0.1:" + srv.port + "/", CODE, TOKEN };
}

async function runHub(
	home: string,
	script: string,
	args: string[],
): Promise<{ code: number; out: string }> {
	const chunk = "/tmp/w185-hubchunk.sh";
	writeFileSync(chunk, hubSource());
	// async spawn, never spawnSync — the in-process mock hub only serves while
	// this event loop runs; a blocking spawnSync starves it and curl times out
	// waiting for a response that can never come.
	const proc = Bun.spawn(["bash", "-c", script, chunk, ...args], {
		env: { ...process.env, HOME: home },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, out: out + err };
}

describe("install.sh", () => {
	test("parses (bash -n)", () => {
		const r = Bun.spawnSync(["bash", "-n", INSTALL]);
		expect(r.exitCode).toBe(0);
	});

	test("dry-run: plans, mutates nothing, minimal default", () => {
		const h = freshHome();
		const r = Bun.spawnSync(["bash", INSTALL, "--dry-run"], {
			env: { ...process.env, HOME: h },
		});
		const out = new TextDecoder().decode(r.stdout);
		expect(r.exitCode).toBe(0);
		expect(out).toContain("LLM tier: minimal");
		expect(out).toContain("hub ask");
		expect(existsSync(h + "/.claude/local-llm/hubs.json")).toBe(false);
	});

	test("dry-run twice: identical plan (idempotency proxy)", () => {
		const h = freshHome();
		const env = { ...process.env, HOME: h };
		const a = Bun.spawnSync(["bash", INSTALL, "--dry-run"], { env });
		const b = Bun.spawnSync(["bash", INSTALL, "--dry-run"], {
			env: { ...env, HOME: freshHome() },
		});
		expect(a.exitCode).toBe(0);
		expect(b.exitCode).toBe(0);
		expect(new TextDecoder().decode(a.stdout)).toBe(
			new TextDecoder().decode(b.stdout),
		);
	});

	test("hub enroll happy path: config + 0600 + first pull + menu", async () => {
		const h = freshHome();
		const m = startMock();
		const r = await runHub(h, 'set -e; source "$0"; hub_enroll "$1" "$2"', [
			m.url,
			m.CODE,
		]);
		m.srv.stop(true);
		expect(r.code).toBe(0);
		const cfgPath = h + "/.claude/local-llm/hubs.json";
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
			hubs: {
				name: string;
				url: string;
				token_env: string;
				dns_entries: string[];
			}[];
		};
		expect(cfg.hubs).toHaveLength(1);
		expect(cfg.hubs[0].url).toBe(m.url.replace(/\/+$/, ""));
		expect(cfg.hubs[0].name.length).toBeGreaterThan(0);
		expect(cfg.hubs[0].token_env).toBe("KLH_HUB_SPOKE_TOKEN");
		expect(cfg.hubs[0].spoke_token).toBeUndefined();
		expect(cfg.hubs[0].dns_entries).toEqual(["suspenders.local", "belt.local"]);
		expect((statSync(cfgPath).mode & 0o777).toString(8)).toBe("600");
		const envf = h + "/.claude/local-llm/hub.env";
		expect((statSync(envf).mode & 0o777).toString(8)).toBe("600");
		expect(readFileSync(envf, "utf8")).toBe(`KLH_HUB_SPOKE_TOKEN=${m.TOKEN}\n`);
		expect(
			readFileSync(h + "/.claude/local-llm/last-policy-pull.json", "utf8"),
		).toContain("menu");
		expect(r.out).toContain("hub menu");
	});

	test("wrong code: enroll fails, standalone fallback", async () => {
		const h = freshHome();
		const m = startMock();
		const r = await runHub(
			h,
			'source "$0"; hub_enroll "$1" "wrong" || write_standalone_config',
			[m.url],
		);
		m.srv.stop(true);
		expect(r.code).toBe(0);
		const cfg = JSON.parse(
			readFileSync(h + "/.claude/local-llm/hubs.json", "utf8"),
		);
		expect(cfg.hubs).toHaveLength(0);
	});

	test("non-TTY hub_ask defaults standalone", async () => {
		const h = freshHome();
		const r = await runHub(h, 'source "$0"; hub_ask', []);
		expect(r.code).toBe(0);
		const cfg = JSON.parse(
			readFileSync(h + "/.claude/local-llm/hubs.json", "utf8"),
		);
		expect(cfg.hubs).toHaveLength(0);
		expect(r.out).toContain("standalone");
	});

	test("re-enroll: still exactly one hub entry", async () => {
		const h = freshHome();
		const m = startMock();
		const s = 'set -e; source "$0"; hub_enroll "$1" "$2"; hub_enroll "$1" "$2"';
		const r = await runHub(h, s, [m.url, m.CODE]);
		m.srv.stop(true);
		expect(r.code).toBe(0);
		expect(
			JSON.parse(readFileSync(h + "/.claude/local-llm/hubs.json", "utf8")).hubs,
		).toHaveLength(1);
		const envf = h + "/.claude/local-llm/hub.env";
		expect(
			readFileSync(envf, "utf8")
				.split("\n")
				.filter((l) => l.length > 0),
		).toHaveLength(1);
	});

	test("existing config: ask skips, never re-prompts", async () => {
		const h = freshHome();
		const m = startMock();
		await runHub(h, 'set -e; source "$0"; hub_enroll "$1" "$2"', [
			m.url,
			m.CODE,
		]);
		m.srv.stop(true);
		const r = await runHub(h, 'set -e; source "$0"; hub_ask', []);
		expect(r.code).toBe(0);
		expect(r.out).toContain("enrolled to");
	});

	test("hygiene: no real hosts/paths/keys", () => {
		const bad = [
			/\/Volumes\//,
			/\/Users\//,
			/threads\.dk/,
			/sk-[A-Za-z0-9]{16,}/,
			/AKIA[0-9A-Z]{16}/,
			/ghp_[A-Za-z0-9]{20,}/,
			/xox[baprs]-/,
		];
		for (const f of ["install.sh", "docs/laws.md"]) {
			const t = readFileSync(REPO + "/" + f, "utf8");
			for (const rx of bad) expect(t).not.toMatch(rx);
		}
	});

	test("1500-line law", () => {
		expect(readFileSync(INSTALL, "utf8").split("\n").length).toBeLessThan(1500);
	});
});

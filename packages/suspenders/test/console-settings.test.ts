// console-settings.test.ts — W147: the board console shell + settings flow.
// Unit: policy parse/patch/diff + board-settings merge on TEMP files only.
// HTTP: console routes against a real board on a throwaway port with a temp
// HOME and BELT_POLICY pinned to a TEMP COPY of the policy — never the live
// belt policy, never the committed default.

import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ConfigError,
	type BoardSettings,
	diffLines,
	parsePolicy,
	patchPolicyText,
	policyWritePath,
	readBoardSettings,
	resolvePolicy,
	applyBoardSettings,
	boardSettingsPath,
	formToBoardSettings,
} from "../hooks/lib/board-config.ts";

const HOME = mkdtempSync(join(tmpdir(), "w147-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w147-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const POLICY = join(HOME, "policy-copy.yaml");
const REG = join(HOME, "registry.json");
writeFileSync(
	POLICY,
	`# kept comment — operators edit this file, never code
version: 1

gateway:
  num_retries: 1
  allowed_fails: 3
  cooldown_time: 30
  fallbacks:
    glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]
`,
);

const env = {
	...process.env,
	HOME,
	BELT_POLICY: POLICY,
	KLH_LOCAL_REGISTRY: REG,
	SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
	SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
	SUSPENDERS_MDNS: "0",
	// W360: probes ride stub deps — DOWN tiles are deterministic and no real
	// loopback port is touched (the live stack running here flipped them UP)
	SUSPENDERS_PROBE_DEPS: "stub",
};
const bin = join(import.meta.dir, "..", "hooks", "bin");
// random port per run — a leaked board from a dead run must never answer
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
writeFileSync(
	REG,
	`[{"name":"bar","port":7792,"created_at":"2026-09-28T10:58:27.897Z"}]`,
);

const proc = Bun.spawn(
	["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)],
	{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${BASE}/api/data`)).ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error("console test board did not start");
}
await waitUp();

afterAll(async () => {
	proc.kill();
	await proc.exited;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// W264: the board's HTML pages hand the browser its write token as an
// HttpOnly cookie — the form posts below ride it exactly as a browser would
const COOKIE = (
	(await fetch(`${BASE}/console/settings/suspenders`)).headers.get(
		"set-cookie",
	) ?? ""
).split(";")[0];

// form-post helper (no Origin header → loopback Host + cookie token path)
const postForm = async (
	path: string,
	fields: Record<string, string>,
): Promise<Response> =>
	fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie: COOKIE,
		},
		body: new URLSearchParams(fields).toString(),
	});

const POLICY_TEXT = readFileSync(POLICY, "utf8");

describe("policy config surface (board-config)", () => {
	test("parsePolicy: valid doc, defaults, budgets validated", () => {
		const gw = parsePolicy(POLICY_TEXT);
		expect(gw.num_retries).toBe(1);
		expect(gw.cooldown_time).toBe(30);
		expect(gw.fallbacks["glm-5.3-flash"]).toEqual([
			"local-swarm",
			"gpt-5.2",
			"claude-sonnet-5",
		]);
		expect(() => parsePolicy("gateway:\n  num_retries: -2\n")).toThrow(
			ConfigError,
		);
		expect(() => parsePolicy(":::not yaml [")).toThrow(ConfigError);
	});

	test("flashx is refused everywhere (owner directive)", () => {
		expect(() =>
			parsePolicy(
				"gateway:\n  fallbacks:\n    glm-5.3-flash: [flashx, local-swarm]\n",
			),
		).toThrow(/flashx/);
	});

	test("patchPolicyText: budgets + ladder edit in place, comments kept, invalid never lands", () => {
		const next = patchPolicyText(POLICY_TEXT, {
			num_retries: 2,
			ladder: { model: "glm-5.3-flash", tiers: ["local-swarm", "gpt-5.2"] },
		});
		expect(next).toContain("# kept comment");
		expect(next).toContain("num_retries: 2");
		expect(next).toContain("glm-5.3-flash: [local-swarm, gpt-5.2]");
		expect(() =>
			patchPolicyText(POLICY_TEXT, {
				ladder: { model: "glm-5.3-flash", tiers: ["flashx"] },
			}),
		).toThrow(ConfigError);
		expect(readFileSync(POLICY, "utf8")).toContain("num_retries: 1");
	});

	test("diffLines: prefix/suffix trimmed, del+add blocks", () => {
		const d = diffLines("a\nb\nc\n", "a\nB\nc\n");
		expect(d).toEqual(["- b", "+ B"]);
	});

	test("board settings: validate, form coercion, apply round-trip on a temp file", () => {
		const p = join(HOME, "board-settings.json");
		const patch: BoardSettings = formToBoardSettings({
			status_refresh_s: "12",
			harvest_ttl_s: "",
			default_actor: "demo:carol@demo",
		});
		expect(patch).toEqual({
			status_refresh_s: 12,
			default_actor: "demo:carol@demo",
		});
		expect(() => formToBoardSettings({ status_refresh_s: "nope" })).toThrow(
			ConfigError,
		);
		applyBoardSettings(p, patch);
		const st = readBoardSettings(p);
		expect(st.exists).toBe(true);
		expect(st.settings.status_refresh_s).toBe(12);
		expect(st.settings.harvest_ttl_s).toBeUndefined();
		const st2 = readBoardSettings(p);
		expect(() =>
			applyBoardSettings(p, { status_refresh_s: 5 }, st2.mtimeMs + 9999),
		).toThrow(/changed since the preview/);
		expect(readBoardSettings(p).settings.status_refresh_s).toBe(12);
	});

	test("resolvePolicy + policyWritePath walk env → runtime → default", () => {
		const r = resolvePolicy({
			env: { BELT_POLICY: POLICY } as unknown as NodeJS.ProcessEnv,
			home: HOME,
		});
		expect(r?.path).toBe(POLICY);
		expect(r?.source).toBe("env");
		mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
		const rt = join(HOME, ".claude", "local-llm", "routing-policy.yaml");
		writeFileSync(rt, POLICY_TEXT);
		const r2 = resolvePolicy({
			env: {} as NodeJS.ProcessEnv,
			home: HOME,
			beltRepo: "/nonexistent-belt",
		});
		expect(r2?.source).toBe("runtime");
		const wp = policyWritePath({
			env: { HOME } as unknown as NodeJS.ProcessEnv,
		});
		expect(wp).toBe(rt);
	});
});

describe("console routes (real board, temp config)", () => {
	test("shell on / and /usage; console sections render", async () => {
		const home = await (await fetch(`${BASE}/`)).text();
		expect(home).toContain('id="cbar"');
		expect(home).toContain('href="/console/belt"');
		expect(home).toContain('href="/console/local"');
		expect(home).toContain('id="cavbtn"');
		expect(home).toContain("/api/console/me");
		const usage = await (await fetch(`${BASE}/usage`)).text();
		expect(usage).toContain('id="cbar"');
		expect(usage).toContain("cavbtn");
		const belt = await (await fetch(`${BASE}/console/belt`)).text();
		expect(belt).toContain("Routing policy");
		expect(belt).toContain("glm-5.3-flash");
		expect(belt).toContain("local-swarm");
		expect(belt).toContain("aria-current"); // belt menu item active
		// stub probes → every tile classifies DOWN, deterministically
		expect(belt).toMatch(/DOWN/);
		const local = await (await fetch(`${BASE}/console/local`)).text();
		expect(local).toContain("bar");
		expect(local).toContain("7792");
	});

	test("W273: service rows + re-probe endpoint + vendored row module", async () => {
		const belt = await (await fetch(`${BASE}/console/belt`)).text();
		expect(belt).toContain("<klh-service-row");
		expect(belt).toContain('data-service="belt-gateway-4000"');
		const all = (await (await fetch(`${BASE}/api/services`)).json()) as {
			ok: boolean;
			services: { id: string; recovery: unknown }[];
		};
		expect(all.ok).toBe(true);
		expect(all.services.length).toBeGreaterThan(5);
		expect(all.services.every((s) => s.recovery !== null)).toBe(true);
		const one = await fetch(`${BASE}/api/services/probe?id=buckle-4101`);
		expect(one.status).toBe(200);
		const d = (await one.json()) as { service: { id: string; state: string } };
		expect(d.service.id).toBe("buckle-4101");
		expect(["up", "degraded", "down"]).toContain(d.service.state);
		const bad = await fetch(`${BASE}/api/services/probe?id=nope`);
		expect(bad.status).toBe(404);
		const js = await fetch(`${BASE}/vendor/klh-service-row.js`);
		expect(js.status).toBe(200);
		expect(await js.text()).toContain("klh-service-row");
	});

	test("/api/console/me: unassigned until an actor is stamped", async () => {
		const d = (await (await fetch(`${BASE}/api/console/me`)).json()) as Record<
			string,
			unknown
		>;
		expect(d.ok).toBe(true);
		expect(d.actor).toBe("unassigned");
		expect(Array.isArray(d.actors)).toBe(true);
	});

	test("settings form pages render with current values", async () => {
		const belt = await (await fetch(`${BASE}/console/settings/belt`)).text();
		expect(belt).toContain('name="num_retries"');
		expect(belt).toContain('value="1"');
		const buck = await (await fetch(`${BASE}/console/settings/buckle`)).text();
		expect(buck).toContain('name="ladder_glm-5.3-flash"');
		const susp = await (
			await fetch(`${BASE}/console/settings/suspenders`)
		).text();
		expect(susp).toContain('name="status_refresh_s"');
	});

	test("preview → apply round-trip writes the TEMP policy copy", async () => {
		const before = readFileSync(POLICY, "utf8");
		const pv = await postForm("/console/settings/preview", {
			feature: "belt",
			num_retries: "2",
			allowed_fails: "",
			cooldown_time: "",
		});
		const page = await pv.text();
		expect(page).toContain('pre class="diff"');
		const values = page.match(/name="values" value="([^"]*)"/)?.[1] ?? "";
		const mtime = page.match(/name="mtime" value="([^"]*)"/)?.[1] ?? "";
		expect(Buffer.from(values, "base64").toString("utf8")).toContain(
			"num_retries",
		);
		const ap = await postForm("/console/settings/apply", {
			feature: "belt",
			values,
			mtime,
		});
		expect(ap.status).toBe(303);
		expect(readFileSync(POLICY, "utf8")).not.toBe(before);
		expect(readFileSync(POLICY, "utf8")).toContain("num_retries: 2");
	});

	test("invalid config rejected with the parse error, nothing written", async () => {
		const before = readFileSync(POLICY, "utf8");
		const pv = await postForm("/console/settings/preview", {
			feature: "buckle",
			"ladder_glm-5.3-flash": "flashx, local-swarm",
			cooldown_time: "",
		});
		const page = await pv.text();
		expect(page).toMatch(/flashx is refused/);
		const ap = await postForm("/console/settings/apply", {
			feature: "buckle",
			values: Buffer.from(
				JSON.stringify({
					ladder: { model: "glm-5.3-flash", tiers: ["flashx"] },
				}),
			).toString("base64"),
			mtime: String(statSync(POLICY).mtimeMs),
		});
		expect(await ap.text()).toMatch(/flashx/);
		expect(readFileSync(POLICY, "utf8")).toBe(before);
	});

	test("suspenders knobs round-trip on the temp HOME", async () => {
		const pv = await postForm("/console/settings/preview", {
			feature: "suspenders",
			status_refresh_s: "9",
			harvest_ttl_s: "120",
			default_actor: "demo:carol@demo",
		});
		const page = await pv.text();
		const values = page.match(/name="values" value="([^"]*)"/)?.[1] ?? "";
		const mtime = page.match(/name="mtime" value="([^"]*)"/)?.[1] ?? "";
		const ap = await postForm("/console/settings/apply", {
			feature: "suspenders",
			values,
			mtime,
		});
		expect(ap.status).toBe(303);
		const st = readBoardSettings(boardSettingsPath(HOME));
		expect(st.settings.status_refresh_s).toBe(9);
		expect(st.settings.harvest_ttl_s).toBe(120);
	});
});

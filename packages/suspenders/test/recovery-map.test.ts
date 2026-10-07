// test/recovery-map.test.ts — W273 recovery UX: the recovery map is
// complete for every probed service, its commands never leak secrets or
// real hosts, probes classify stub results honestly, and a DOWN row
// renders (server fallback + row model) with its recovery path while an
// UP row stays quiet. The re-probe controller updates the row from a stub.
import { describe, expect, test } from "bun:test";
import {
	PROBED_SERVICES,
	RECOVERY_MAP,
	leaksIn,
	recoveryFor,
} from "../hooks/lib/recovery-map.ts";
import {
	type ProbeDeps,
	probeAll,
	probeService,
	withRecovery,
} from "../hooks/board/service-probe.ts";
import {
	type RowProbe,
	ServiceRowController,
	rowModel,
} from "../hooks/board-html/service-row-model.ts";
import { beltPage, serviceRowHtml } from "../hooks/bin/console-html.ts";

const NOW = new Date();

// stub probe world: port → response (or throw = refused); label → launchctl
const stubDeps = (
	http: Record<number, number | "refused">,
	agents: Record<string, { code: number; out: string }> = {},
): ProbeDeps => ({
	fetch: async (url) => {
		const port = Number(new URL(url).port);
		const v = http[port] ?? "refused";
		if (v === "refused") throw new Error("Unable to connect. ECONNREFUSED");
		if (port === 4100) return Response.json("I'm alive!", { status: v });
		return new Response(
			JSON.stringify({ uptime_s: 12, requests: { total: 3 } }),
			{
				status: v,
			},
		);
	},
	launchctl: async (label) => agents[label] ?? { code: 113, out: "" },
	now: () => NOW,
});

describe("recovery map completeness", () => {
	test("every probed service has a full recovery entry", () => {
		expect(PROBED_SERVICES.length).toBeGreaterThan(0);
		for (const id of PROBED_SERVICES) {
			const e = recoveryFor(id);
			expect(e, id).not.toBeNull();
			expect(e?.what.length, id).toBeGreaterThan(20);
			expect(e?.what.includes("\n"), id).toBe(false);
			expect(e?.causes.length, id).toBeGreaterThan(0);
			expect(e?.recovery.length, id).toBeGreaterThan(0);
		}
	});

	test("covers the fleet the brief names", () => {
		const ports = Object.values(RECOVERY_MAP).flatMap((e) =>
			e.probe.kind === "http" ? [e.probe.port] : [],
		);
		for (const p of [4000, 4100, 4101, 8901, 8902, 8903, 8912, 7799, 2019])
			expect(ports).toContain(p);
		const labels = Object.values(RECOVERY_MAP).flatMap((e) =>
			e.probe.kind === "launchd" ? [e.probe.label] : [],
		);
		expect(labels).toContain("com.suspenders.local-llm");
		// W277: the standalone com.belt.gateway restarter was retired (it was
		// a second :4100 restarter racing the swarm supervisor — a fork-bomb
		// hazard); litellm now lives solely under launchd-local-llm.
		expect(labels).not.toContain("com.belt.gateway");
		expect(RECOVERY_MAP.caddy).toBeDefined();
	});

	test("launchd restarts use the exact kickstart form", () => {
		const cmds = Object.values(RECOVERY_MAP).flatMap((e) =>
			e.recovery.map((s) => s.cmd),
		);
		expect(cmds).toContain(
			"launchctl kickstart -k gui/$(id -u)/com.suspenders.local-llm",
		);
		// the orphaned-:4000 case (2026-10-03) has a kill-the-orphan step
		expect(
			RECOVERY_MAP["belt-gateway-4000"].recovery.map((s) => s.cmd),
		).toContain("kill $(lsof -tiTCP:4000 -sTCP:LISTEN)");
	});

	test("placeholder law: no secrets, real hosts or home paths", () => {
		for (const e of Object.values(RECOVERY_MAP)) {
			const text = [
				e.name,
				e.what,
				...e.causes,
				...e.recovery.flatMap((s) => [s.label, s.cmd]),
			].join("\n");
			expect(leaksIn(text), e.id).toEqual([]);
		}
	});

	test("the leak detector actually bites", () => {
		expect(leaksIn("curl -H 'Authorization: Bearer abc123'")).not.toEqual([]);
		expect(leaksIn("export OPENAI_API_KEY=sk-abcdefghijklmnop")).not.toEqual(
			[],
		);
		expect(leaksIn("tail /Users/someone/x.log")).not.toEqual([]);
		expect(leaksIn("curl http://studio.example.com:4000/")).not.toEqual([]);
		expect(leaksIn("ssh 192.168.1.20")).not.toEqual([]);
		expect(leaksIn("curl http://127.0.0.1:4000/health")).toEqual([]);
	});
});

describe("probes (stub results)", () => {
	test("http: configured check success → up, 4xx/5xx → degraded, refused → down", async () => {
		const deps = stubDeps({ 4000: 404, 4100: 503 });
		const shim = await probeService("belt-gateway-4000", deps);
		expect(shim?.state).toBe("degraded");
		expect(shim?.up).toBe(false);
		expect(shim?.detail).toContain("configured check failed");
		const lite = await probeService("litellm-4100", deps);
		expect(lite?.state).toBe("degraded");
		expect(lite?.detail).toContain("HTTP 503");
		const buckle = await probeService("buckle-4101", deps);
		expect(buckle?.state).toBe("down");
		expect(buckle?.detail).toContain("ECONNREFUSED");
		expect(buckle?.probed_at).toBe(NOW.toISOString());
	});

	test("launchd: running → up, loaded-not-running → degraded, absent → down", async () => {
		const deps = stubDeps(
			{},
			{
				"com.suspenders.local-llm": {
					code: 0,
					out: "\tstate = running\n\tpid = 4242\n",
				},
			},
		);
		const sw = await probeService("launchd-local-llm", deps);
		expect(sw?.state).toBe("up");
		expect(sw?.detail).toContain("pid 4242");
		const degraded = await probeService(
			"launchd-local-llm",
			stubDeps(
				{},
				{
					"com.suspenders.local-llm": {
						code: 0,
						out: "\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n",
					},
				},
			),
		);
		expect(degraded?.state).toBe("degraded");
		expect(degraded?.detail).toContain("EX_CONFIG");
		const none = await probeService("launchd-local-llm", stubDeps({}));
		expect(none?.state).toBe("down");
		// W277: com.belt.gateway is retired — no recovery entry for it anymore
		expect(recoveryFor("launchd-belt-gateway")).toBeNull();
	});

	test("unknown id → null; probeAll covers every probed service", async () => {
		expect(await probeService("nope", stubDeps({}))).toBeNull();
		const all = await probeAll(stubDeps({}));
		expect(all.map((p) => p.id)).toEqual([...PROBED_SERVICES]);
		expect(all.every((p) => withRecovery(p).recovery !== null)).toBe(true);
	});
});

const rowOf = async (id: string, deps: ProbeDeps): Promise<RowProbe> => {
	const p = await probeService(id, deps);
	if (!p) throw new Error(`no probe ${id}`);
	return withRecovery(p);
};

describe("row behavior", () => {
	test("DOWN row: open recovery with what/causes/steps", async () => {
		const m = rowModel(await rowOf("belt-gateway-4000", stubDeps({})));
		expect(m.badge).toBe("DOWN");
		expect(m.showRecovery).toBe(true);
		expect(m.open).toBe(true);
		expect(m.what).toContain(":4000");
		expect(m.causes.length).toBeGreaterThan(0);
		expect(m.steps[0].cmd).toBe("lsof -nP -iTCP:4000 -sTCP:LISTEN");
	});

	test("degraded row: recovery offered but collapsed; UP row stays quiet", async () => {
		const d = rowModel(await rowOf("litellm-4100", stubDeps({ 4100: 500 })));
		expect(d.badge).toBe("DEGRADED");
		expect(d.showRecovery).toBe(true);
		expect(d.open).toBe(false);
		const u = rowModel(await rowOf("litellm-4100", stubDeps({ 4100: 200 })));
		expect(u.badge).toBe("UP");
		expect(u.showRecovery).toBe(false);
		expect(u.steps).toEqual([]);
	});

	test("re-probe updates the row live from the probe endpoint", async () => {
		const down = await rowOf("kev-8912", stubDeps({}));
		const up = await rowOf("kev-8912", stubDeps({ 8912: 200 }));
		const c = new ServiceRowController(down);
		const seen: string[] = [];
		const next = await c.reprobe(async (u) => {
			seen.push(u);
			return Response.json({ ok: true, service: up });
		});
		expect(seen).toEqual(["/api/services/probe?id=kev-8912"]);
		expect(next.state).toBe("up");
		expect(c.err).toBeNull();
		expect(c.busy).toBe(false);
	});

	test("failed re-probe keeps the last probe and reports why", async () => {
		const down = await rowOf("kev-8912", stubDeps({}));
		const c = new ServiceRowController(down);
		const next = await c.reprobe(async () =>
			Response.json(
				{ ok: false, error: "unknown service id" },
				{ status: 404 },
			),
		);
		expect(next).toBe(down);
		expect(c.err).toBe("unknown service id");
	});
});

describe("server rendering", () => {
	test("DOWN row: Lit host + escaped probe JSON + no-JS fallback commands", async () => {
		const html = serviceRowHtml(await rowOf("belt-gateway-4000", stubDeps({})));
		expect(html).toStartWith("<klh-service-row");
		expect(html).toContain('data-state="down"');
		expect(html).toContain("how to recover");
		expect(html).toContain("kill $(lsof -tiTCP:4000 -sTCP:LISTEN)");
		// the probe attribute is escaped JSON (no raw quotes break out)
		const attr = html.match(/probe="([^"]*)"/)?.[1] ?? "";
		const parsed = JSON.parse(
			attr
				.replaceAll("&quot;", '"')
				.replaceAll("&lt;", "<")
				.replaceAll("&gt;", ">")
				.replaceAll("&amp;", "&"),
		);
		expect(parsed.id).toBe("belt-gateway-4000");
		expect(parsed.recovery.recovery.length).toBeGreaterThan(0);
	});

	test("UP row renders no recovery section", async () => {
		const html = serviceRowHtml(await rowOf("caddy", stubDeps({ 2019: 200 })));
		expect(html).toContain('data-state="up"');
		expect(html).not.toContain("how to recover");
	});

	test("belt page: gateway transport rows, the module, no leakage", async () => {
		const health = (await probeAll(stubDeps({ 4101: 200 }))).map(withRecovery);
		const page = beltPage({
			policy: null,
			gateway: null,
			policyError: null,
			beltApi: null,
			health,
			groups: null,
		});
		const transports = ["belt-gateway-4000", "litellm-4100", "buckle-4101"];
		for (const id of transports) expect(page).toContain(`data-service="${id}"`);
		expect(page).not.toContain('data-service="swarm-8901"');
		expect(page).toContain('src="/vendor/klh-service-row.js"');
		expect(page).toContain("1/3 up");
		const rows =
			page.match(/<klh-service-row[\s\S]*?<\/klh-service-row>/g) ?? [];
		expect(rows.length).toBe(transports.length);
		const text = rows
			.join("\n")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&quot;", '"')
			.replaceAll("&amp;", "&");
		expect(leaksIn(text)).toEqual([]);
	});
});

// deploy/singbox/windows.test.ts — W1264.1 co-situated tests: egress rule
// shape + boundaries, catalog-mode mapping, render, and the install/status/
// uninstall flows with an injected runner (no native calls, no machine
// probes — every spawn is an argument array recorded in-memory).
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import {
	AI_EGRESS_DOMAINS,
	BUCKLE_ROUTE_META,
	buildEgressPlan,
	egressModeFor,
	GUI_AI_APPS,
	type EgressDetect,
	singboxEgressRules,
} from "./egress.ts";
import {
	clashVersion,
	confValues,
	installTun,
	type NativeRunner,
	renderConfig,
	schtasksCreateArgs,
	statusTun,
	uninstallTun,
	checkTun,
} from "./windows.ts";

const FULL_ENV: Record<string, string> = {
	KLH_SINGBOX_RELAY_HOST: "relay.example.internal",
	KLH_SINGBOX_RELAY_PORT: "3128",
	KLH_SINGBOX_CLASH_PORT: "9090",
	KLH_SINGBOX_CLASH_SECRET: "test-secret",
	KLH_SINGBOX_LOG_FILE: "C:\\ProgramData\\klh\\sing-box\\sing-box.log",
};

const recordingRunner = (
	code = 0,
): { runner: NativeRunner; calls: string[][] } => {
	const calls: string[][] = [];
	const runner: NativeRunner = async (cmd) => {
		calls.push(cmd);
		return { code, stdout: "TASKNAME ok", stderr: "" };
	};
	return { runner, calls };
};

test.describe("egress rules", () => {
	test("rules land in match order: dns, sniff, private-direct, gui, domains", () => {
		const rules = singboxEgressRules();
		expect(rules[0]).toEqual({ protocol: "dns", action: "hijack-dns" });
		expect(rules[1]).toEqual({ inbound: "tun-in", action: "sniff" });
		expect(rules[2]).toEqual({ ip_is_private: true, outbound: "direct" });
	});

	test("process rules are the GUI set only — never catalog CLIs", () => {
		const rules = singboxEgressRules();
		const proc = rules.filter((r) => "process_name" in (r as object));
		expect(proc).toHaveLength(GUI_AI_APPS.length);
		expect(
			proc.map((r) => (r as { process_name: string[] }).process_name[0]),
		).toEqual(GUI_AI_APPS.map((g) => g.name));
	});

	test("domain rule steers exactly the curated AI set to the hub relay", () => {
		const rules = singboxEgressRules();
		const domain = rules.find((r) => "domain_suffix" in (r as object));
		expect(domain).toEqual({
			domain_suffix: [...AI_EGRESS_DOMAINS],
			outbound: "hub-relay",
		});
	});
});

test.describe("egress modes", () => {
	test("buckleCompatible=true installed target rides app-native", () => {
		expect(egressModeFor(true, true)).toBe("app-native");
	});
	test("unaudited and non-buckle installed targets get TUN domain coverage", () => {
		expect(egressModeFor("unknown", true)).toBe("tun-domain-coverage");
		expect(egressModeFor(false, true)).toBe("tun-domain-coverage");
	});
	test("undetected targets stay undetected", () => {
		expect(egressModeFor(true, false)).toBe("undetected");
	});
});

const mkRow = (
	type: string,
	buckle: boolean | "unknown",
	installed: boolean,
): unknown => ({
	type,
	displayName: type,
	installed,
	supported: true,
	native: false,
	capabilities: {
		detected: installed,
		skillInstallable: true,
		hookWired: true,
		hookRegistration: "present",
		headlessSpawnable: true,
		sessionResumable: true,
		buckleCompatible: buckle,
	},
});

test.describe("buildEgressPlan", () => {
	test("maps catalog capabilities to egress modes; GUI apps tun-only", async () => {
		const rows = [
			mkRow("claude-code", true, true),
			mkRow("codex", true, false),
			mkRow("grok", "unknown", true),
			mkRow("cline", false, true),
		] as unknown as Awaited<ReturnType<EgressDetect>>;
		const fake = (async () => rows) as unknown as EgressDetect;
		const plan = await buildEgressPlan("/repo", fake);
		const byType = new Map(plan.targets.map((t) => [t.type, t]));
		expect(byType.get("claude-code")?.egressMode).toBe("app-native");
		expect(byType.get("codex")?.egressMode).toBe("undetected");
		expect(byType.get("grok")?.egressMode).toBe("tun-domain-coverage");
		expect(byType.get("cline")?.egressMode).toBe("tun-domain-coverage");
		expect(plan.guiApps.every((g) => g.coverage === "tun")).toBe(true);
		expect(plan.routes.source).toBe(BUCKLE_ROUTE_META.source);
	});
});

test.describe("renderConfig", () => {
	test("fills placeholders and injects the egress rules", () => {
		const rendered = renderConfig(FULL_ENV);
		expect(rendered.unfilled).toEqual([]);
		const conf = JSON.parse(rendered.json) as Record<string, unknown>;
		const route = conf.route as { rules: unknown[] };
		expect(route.rules.length).toBe(3 + GUI_AI_APPS.length + 1);
		const outbounds = conf.outbounds as Array<{ tag: string; server?: string }>;
		const hub = outbounds.find((o) => o.tag === "hub-relay");
		expect(hub?.server).toBe(FULL_ENV.KLH_SINGBOX_RELAY_HOST);
	});
	test("template placeholders surface as unfilled without env", () => {
		const rendered = renderConfig({});
		expect(rendered.unfilled.length).toBeGreaterThan(0);
	});
});

test.describe("confValues", () => {
	test("empty-string env counts as unset", () => {
		const v = confValues({ ...FULL_ENV, KLH_SINGBOX_CLASH_SECRET: "" });
		expect(v.missing).toContain("KLH_SINGBOX_CLASH_SECRET");
	});
	test("all five values present → empty missing list", () => {
		expect(confValues(FULL_ENV).missing).toEqual([]);
	});
});

test("schtasks create args pin SYSTEM + ONSTART with quoted paths", () => {
	const args = schtasksCreateArgs(
		"C:\\bin\\sing-box.exe",
		"C:\\conf\\config.json",
	);
	expect(args).toContain("SYSTEM");
	expect(args).toContain("ONSTART");
	expect(args).toContain(
		`"C:\\bin\\sing-box.exe" run -c "C:\\conf\\config.json"`,
	);
});

test.describe("installTun", () => {
	const tmpDirs: string[] = [];
	test.afterAll(() => {
		for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	});

	test("refuses a non-windows platform before touching anything", async () => {
		const { runner, calls } = recordingRunner(0);
		expect(
			installTun({ runner, env: FULL_ENV, platform: "darwin" }),
		).rejects.toThrow("windows host required");
		expect(calls).toEqual([]);
	});

	test("missing machine values fail before any native call", async () => {
		const { runner, calls } = recordingRunner(0);
		expect(installTun({ runner, env: {}, platform: "win32" })).rejects.toThrow(
			"missing machine values",
		);
		expect(calls).toEqual([]);
	});

	const stagedBin = (): { bin: string; dir: string } => {
		const dir = mkdtempSync(join(tmpdir(), "singbox-win-"));
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "sing-box.exe"), "stub");
		writeFileSync(join(bin, "wintun.dll"), "stub");
		return { bin, dir };
	};

	test("renders the conf and registers the ONSTART SYSTEM task", async () => {
		const { bin, dir } = stagedBin();
		const { runner, calls } = recordingRunner(0);
		const env = {
			...FULL_ENV,
			KLH_SINGBOX_WIN_DIR: dir,
			KLH_SINGBOX_WIN_BIN: bin,
		};
		const steps = await installTun({ runner, env, platform: "win32" });
		expect(steps).toHaveLength(3);
		const create = calls.find((c) => c[0] === "schtasks" && c[1] === "/Create");
		expect(create?.includes("SYSTEM")).toBe(true);
		expect(create?.includes("ONSTART")).toBe(true);
		const conf = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
			route: { rules: unknown[] };
		};
		expect(conf.route.rules.length).toBeGreaterThan(0);
	});
});

test("uninstallTun refuses without --yes; deletes task + conf dir with it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "singbox-win-"));
	writeFileSync(join(dir, "config.json"), "{}");
	const { runner, calls } = recordingRunner(0);
	expect(
		uninstallTun(false, { runner, env: {}, platform: "win32" }),
	).rejects.toThrow("--yes");
	const steps = await uninstallTun(true, {
		runner,
		env: { KLH_SINGBOX_WIN_DIR: dir },
		platform: "win32",
	});
	expect(steps).toHaveLength(2);
	const del = calls.find((c) => c[0] === "schtasks" && c[1] === "/Delete");
	expect(del?.includes("/F")).toBe(true);
	expect(() => readFileSync(join(dir, "config.json"))).toThrow();
	rmSync(dir, { recursive: true, force: true });
});

test("statusTun reports the task probe + clash liveness shape", async () => {
	const fetcher = (async () =>
		new Response(JSON.stringify({ version: "1.11.0" }), {
			status: 200,
		})) as unknown as typeof fetch;
	const r = await statusTun({
		runner: recordingRunner(0).runner,
		env: FULL_ENV,
		platform: "win32",
		fetcher,
	});
	expect(r.platform).toBe("win32");
	expect(r.task.code).toBe(0);
	expect(r.clash.ok).toBe(true);
	expect(r.clash.version).toBe("1.11.0");
});

test("clashVersion surfaces the error face when unset", async () => {
	const r = await clashVersion({ env: {} });
	expect(r.ok).toBe(false);
	expect(r.error).toBe("clash port/secret unset");
});

test("checkTun reports honest platform miss on darwin", async () => {
	const { runner } = recordingRunner(0);
	const c = await checkTun({ runner, env: FULL_ENV, platform: "darwin" });
	expect(c.ok).toBe(false);
	expect(c.lines.some((l) => l.includes("windows required"))).toBe(true);
});

test("checkTun on win32 with staged bins and fake admin passes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "singbox-win-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "sing-box.exe"), "stub");
	writeFileSync(join(bin, "wintun.dll"), "stub");
	const { runner } = recordingRunner(0);
	const c = await checkTun({
		runner,
		env: { ...FULL_ENV, KLH_SINGBOX_WIN_BIN: bin },
		platform: "win32",
	});
	expect(c.ok).toBe(true);
	rmSync(dir, { recursive: true, force: true });
});

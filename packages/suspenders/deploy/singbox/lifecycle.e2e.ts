// lifecycle.test.ts — W1260.1: the operable lifecycle, host-free via the
// LifecycleIo seam. Coverage: fill's token refusal + 0600 law-clean conf,
// the ordered bring-up (law → binary → relay-reach → stage → owner door →
// clash liveness), the ordered rollback, and the status composite.
import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DAEMON_LABEL,
	type CmdResult,
	type LifecycleIo,
	clashOf,
	connectPortOf,
	lifecycleDetect,
	lifecycleFill,
	lifecycleOff,
	lifecycleOn,
	lifecycleStatus,
	renderPlist,
	stagedPlistPath,
} from "./lifecycle.ts";
import { checkConfigLaw, readConf } from "./singbox.ts";

const dirs: string[] = [];
test.afterAll(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Env save/restore — bun test runs files in ONE process (env-leak lesson). */
const envSaved = new Map<string, string | undefined>();
const setEnv = (k: string, v: string | undefined): void => {
	if (!envSaved.has(k)) envSaved.set(k, process.env[k]);
	if (v === undefined) delete process.env[k];
	else process.env[k] = v;
};
test.afterAll(() => {
	for (const [k, v] of envSaved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-singlife-"));
	dirs.push(dir);
	return dir;
}

const ok = { code: 0, stdout: "", stderr: "" };
const cmdLog = (
	code = 0,
): { log: string[][]; run: (cmd: string[]) => Promise<CmdResult> } => {
	const log: string[][] = [];
	return {
		log,
		run: async (cmd) => {
			log.push(cmd);
			return { code, stdout: "", stderr: "" };
		},
	};
};

/** The one LifecycleIo knob-set a test wants; everything else succeeds. */
function ioOf(
	o: Partial<LifecycleIo> & { runCode?: number } = {},
): LifecycleIo {
	const { runCode, ...rest } = o;
	const cmd = cmdLog(runCode ?? 0);
	return {
		exists: rest.exists ?? (() => false),
		run: rest.run ?? cmd.run,
		which: rest.which ?? (() => "/usr/local/bin/sing-box"),
		probeTcp: rest.probeTcp ?? (async () => true),
		probeClash: rest.probeClash ?? (async () => true),
	};
}

/** A law-clean machine conf written through the real fill. */
function filledConfPath(): string {
	const token = "BUCKLE_CONNECT_TOKEN";
	setEnv(token, "tok-abcdef1234567890");
	const dir = tmpDir();
	const out = lifecycleFill(join(dir, "singbox.json"), true);
	expect(out.written).not.toBeNull();
	return out.written ?? "";
}

test.beforeEach(() => {
	setEnv("KLH_SINGBOX_PLIST", join(tmpDir(), "tun.plist"));
	setEnv("BUCKLE_CONNECT_PORT", "4103");
	setEnv("KLH_SINGBOX_CLASH_PORT", "9090");
});

// ─── knobs ───────────────────────────────────────────────────────────────────

test("connectPortOf: default 4103, env override, junk falls back", () => {
	delete process.env.BUCKLE_CONNECT_PORT;
	expect(connectPortOf()).toBe(4103);
	setEnv("BUCKLE_CONNECT_PORT", "4110");
	expect(connectPortOf()).toBe(4110);
	setEnv("BUCKLE_CONNECT_PORT", "http");
	expect(connectPortOf()).toBe(4103);
	setEnv("BUCKLE_CONNECT_PORT", "4103");
});

test("clashOf: default 9090 loopback, env override", () => {
	delete process.env.KLH_SINGBOX_CLASH_PORT;
	const d = clashOf();
	expect(d.controller).toBe("127.0.0.1:9090");
	setEnv("KLH_SINGBOX_CLASH_PORT", "9091");
	expect(clashOf().port).toBe(9091);
	setEnv("KLH_SINGBOX_CLASH_PORT", "9090");
});

test("renderPlist: label, binary, conf, KeepAlive — no /Users literal", () => {
	const text = renderPlist({
		binary: "/usr/local/bin/sing-box",
		confPath: "/etc/klh/singbox.json",
		logPath: "/var/log/singbox.log",
	});
	expect(text).toContain(DAEMON_LABEL);
	expect(text).toContain("/usr/local/bin/sing-box");
	expect(text).toContain("/etc/klh/singbox.json");
	expect(text).toContain("KeepAlive");
	expect(text).not.toContain("/Users/");
});

// ─── fill ────────────────────────────────────────────────────────────────────

test("fill: refuses without BUCKLE_CONNECT_TOKEN — never a placeholdered conf", () => {
	setEnv("BUCKLE_CONNECT_TOKEN", undefined);
	const out = lifecycleFill(join(tmpDir(), "singbox.json"), true);
	expect(out.written).toBeNull();
	expect(out.missing[0]).toContain("BUCKLE_CONNECT_TOKEN");
});

test("fill: template + env → a law-clean 0600 conf; never overwrites without --force", () => {
	setEnv("BUCKLE_CONNECT_TOKEN", "tok-abcdef1234567890");
	const target = join(tmpDir(), "singbox.json");
	const out = lifecycleFill(target, true);
	expect(out.written).toBe(target);
	expect(statSync(target).mode & 0o777).toBe(0o600);
	expect(checkConfigLaw(readConf(target))).toEqual([]);
	// a real conf is never silently refilled
	setEnv("KLH_SINGBOX_CLASH_PORT", "9095");
	const again = lifecycleFill(target, false);
	expect(again.written).toBeNull();
	setEnv("KLH_SINGBOX_CLASH_PORT", "9090");
});

// ─── detect ──────────────────────────────────────────────────────────────

test("detect: transport observation over the injected exists — never tool selection", () => {
	const rows = lifecycleDetect({
		exists: (p) => p.endsWith("ChatGPT.app"),
	});
	expect(rows).toHaveLength(3);
	expect(rows.find((r) => r.user === "chatgpt")?.present).toBe(true);
	expect(rows.find((r) => r.user === "claude")?.present).toBe(false);
});

// ─── on: the ordered bring-up ────────────────────────────────────────────

test("on: refuses clean on an absent conf, law-dirty conf, missing binary, dead relay", async () => {
	const badPath = join(tmpDir(), "nope.json");
	expect((await lifecycleOn(badPath, ioOf())).verdict).toBe("REFUSED");
	// law-dirty: a placeholdered template seed
	const dir = tmpDir();
	const raw = join(dir, "raw.json");
	const { seedConf } = await import("./singbox.ts");
	seedConf(raw, true);
	expect((await lifecycleOn(raw, ioOf())).verdict).toBe("REFUSED");
	// missing binary
	setEnv("BUCKLE_CONNECT_TOKEN", "tok-abcdef1234567890");
	const conf = filledConfPath();
	expect(
		(await lifecycleOn(conf, ioOf({ which: () => null }))).reason,
	).toContain("brew install sing-box");
	// dead relay
	expect(
		(await lifecycleOn(conf, ioOf({ probeTcp: async () => false }))).reason,
	).toContain("relay before TUN");
});

test("on: full ordered bring-up reaches UP with the daemon commands run", async () => {
	const conf = filledConfPath();
	const io = ioOf();
	const out = await lifecycleOn(conf, io);
	expect(out.verdict).toBe("UP");
	expect(out.bootstrap).toBe("done");
	expect(out.clash).toBe(true);
	expect(existsSync(stagedPlistPath())).toBe(true);
});

test("on: bootstrap failure prints the owner resume door, stages the plist", async () => {
	const conf = filledConfPath();
	const io = ioOf({ runCode: 1 });
	const out = await lifecycleOn(conf, io);
	expect(out.verdict).toBe("STAGED");
	expect(out.bootstrap).toBe("owner");
	expect(out.reason).toContain("sudo launchctl bootstrap system");
	expect(out.reason).toContain(DAEMON_LABEL);
});

// ─── off: the ordered rollback ───────────────────────────────────────────

test("off: daemon down → plist removed → env cleared → scutil report", async () => {
	const conf = filledConfPath();
	expect(await lifecycleOn(conf, ioOf()).then((o) => o.verdict)).toBe("UP");
	const log: string[][] = [];
	const io = ioOf({
		exists: (p) => p === stagedPlistPath(),
		run: async (cmd) => {
			log.push(cmd);
			return cmd[0] === "scutil"
				? { code: 0, stdout: "<dictionary> { HTTPEnable : 1 }", stderr: "" }
				: ok;
		},
	});
	const out = await lifecycleOff(io);
	expect(out.daemon).toBe("down");
	expect(out.plistRemoved).toBe(true);
	expect(out.envCleared).toHaveLength(4);
	expect(out.scutilProxy).toContain("HTTPEnable");
	const first = log[0] ?? [];
	expect(first.slice(0, 4)).toEqual(["sudo", "-n", "launchctl", "bootout"]);
});

test("off: an absent daemon still clears env and reports", async () => {
	const out = await lifecycleOff(
		ioOf({
			run: async (cmd) =>
				cmd[3] === "bootout" ? { code: 1, stdout: "", stderr: "" } : ok,
		}),
	);
	expect(out.daemon).toBe("absent");
	expect(out.envCleared).toHaveLength(4);
});

// ─── status ──────────────────────────────────────────────────────────────

test("status: UP needs daemon + clash; dead relay with daemon = DEGRADED", async () => {
	const conf = filledConfPath();
	expect((await lifecycleStatus(conf, ioOf())).verdict).toBe("UP");
	const degraded = await lifecycleStatus(
		conf,
		ioOf({ probeTcp: async () => false }),
	);
	expect(degraded.verdict).toBe("DEGRADED");
	const staged = await lifecycleStatus(
		conf,
		ioOf({
			which: () => null,
			run: async (cmd) =>
				cmd[0] === "pgrep" ? { code: 1, stdout: "", stderr: "" } : ok,
			exists: () => true,
		}),
	);
	expect(staged.verdict).toBe("STAGED");
	const down = await lifecycleStatus(
		conf,
		ioOf({
			which: () => null,
			run: async (cmd) =>
				cmd[0] === "pgrep" ? { code: 1, stdout: "", stderr: "" } : ok,
			probeClash: async () => false,
		}),
	);
	expect(down.verdict).toBe("DOWN");
});

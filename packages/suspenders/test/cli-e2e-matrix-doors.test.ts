// test/cli-e2e-matrix-doors.test.ts — W932: the registered CLI doors beyond
// coord/work. Shim wiring: every SHIM_NAMES entry resolves through a fixture
// prefix (laid out like the installed harness — bin/ + scripts/ symlinks) to
// a real repo file, and the shim script execs the door face. dispatch/hubctl
// render their usage/round-trip faces: hubctl render against a fixture
// stack.yaml via KLH_STACK (config-over-code: no real hosts/keys/ports), the
// oracle exit contract (0 answer · 1 usage · 2 leg), and fleet-tracker's
// pipe-safe --once frame. No network, no machine mutations.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIM_NAMES, shimScript, shimTarget } from "../scripts/ensure-shims.ts";
import { cliFixture, type CliResult } from "./helpers/cli-e2e-harness.ts";

setDefaultTimeout(30_000); // spawn-heavy suite

const fx = cliFixture("doors-matrix");
const PKG = join(import.meta.dir, "..");

// fixture prefix with the installed-harness layout: bin/ + scripts/ symlinks
const PREFIX = mkdtempSync(join(tmpdir(), "w932-doors-prefix-"));
mkdirSync(PREFIX, { recursive: true });
symlinkSync(join(PKG, "hooks", "bin"), join(PREFIX, "bin"), "dir");
symlinkSync(join(PKG, "scripts"), join(PREFIX, "scripts"), "dir");

// fixture stack.yaml — probe-shaped hub profile (version must not be "main")
const STACK = join(PREFIX, "stack.yaml");
writeFileSync(
	STACK,
	[
		"version: v9.9.9-probe",
		"hubs:",
		"  w932hub:",
		"    host: 127.0.0.1",
		"    board_port: 7799",
		"    store_port: 7795",
		"    buckle_port: 4101",
		"    belt_port: 7791",
		"",
	].join("\n"),
);

const door = (
	file: string,
	args: string[],
	extraEnv: Record<string, string> = {},
): CliResult => {
	const p = spawnSync("bun", [file, ...args], {
		cwd: fx.REPO,
		env: { ...process.env, HOME: fx.HOME, ...extraEnv },
		encoding: "utf8",
		timeout: 30_000,
	});
	return {
		code: (p.status ?? p.exitCode ?? -1) as number,
		out: p.stdout ?? "",
		err: p.stderr ?? "",
	};
};

const HUBCTL = join(PKG, "deploy", "hubctl.ts");
const DISPATCH = join(PKG, "scripts", "dispatch-next.ts");
const ORACLE = join(PKG, "hooks", "bin", "oracle.ts");
const TRACKER = join(PKG, "hooks", "bin", "fleet-tracker.ts");

describe("doors — shim wiring contract", () => {
	test("every registered shim resolves to a repo file through the prefix", () => {
		expect(SHIM_NAMES).toContain("coord");
		expect(SHIM_NAMES).toContain("work");
		expect(SHIM_NAMES).toContain("dispatch");
		for (const name of SHIM_NAMES) {
			expect(existsSync(shimTarget(PREFIX, name))).toBe(true);
		}
	});
});

describe("doors — shim exec face", () => {
	test("the shim script execs the real coord door", () => {
		const shimDir = mkdtempSync(join(tmpdir(), "w932-doors-shims-"));
		const coordShim = join(shimDir, "coord");
		writeFileSync(coordShim, shimScript(PREFIX, "coord"), { mode: 0o755 });
		const p = spawnSync(coordShim, ["--help"], {
			cwd: fx.REPO,
			env: { ...process.env, HOME: fx.HOME },
			encoding: "utf8",
			timeout: 30_000,
		});
		rmSync(shimDir, { recursive: true, force: true });
		expect(p.status).toBe(0);
		expect(p.stdout ?? "").toContain("coord — control plane");
	});
});

describe("doors — dispatch usage face", () => {
	test("dispatch --help renders usage without dispatching", () => {
		const r = door(DISPATCH, ["--help"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Usage: dispatch");
	});
});

describe("doors — hubctl against a fixture stack.yaml", () => {
	test("bare invocation prints usage and exits 2", () => {
		const r = door(HUBCTL, [], { KLH_STACK: STACK });
		expect(r.code).toBe(2);
		expect(r.out).toContain("usage: hubctl");
	});
	test("render round-trips the hub profile to compose .env lines", () => {
		const r = door(HUBCTL, ["render", "w932hub"], { KLH_STACK: STACK });
		expect(r.code).toBe(0);
		expect(r.out).toContain("HUB_NAME=w932hub");
		expect(r.out).toContain("HUB_FLEET_REF=v9.9.9-probe");
	});
	test("unknown hub exits 1 and names the stack path", () => {
		const r = door(HUBCTL, ["render", "nope"], { KLH_STACK: STACK });
		expect(r.code).toBe(1);
		expect(r.err).toContain("not in");
	});
});

describe("doors — oracle exit contract", () => {
	test("verb-scoped --help exits 0; bare usage exits 1", () => {
		// oracle's help is verb-scoped: rest is empty without a verb, so
		// `oracle --help` (no verb) falls through to usage — exit 1
		const help = door(ORACLE, ["review", "--help"]);
		expect(help.code).toBe(0);
		expect(help.out).toContain("usage: oracle");
		const bare = door(ORACLE, []);
		expect(bare.code).toBe(1);
		const helpless = door(ORACLE, ["--help"]);
		expect(helpless.code).toBe(1);
	});
});

describe("doors — fleet-tracker read face", () => {
	test("--help renders the flag face; --once renders one read-only frame", () => {
		const help = door(TRACKER, ["--help"]);
		expect(help.code).toBe(0);
		expect(help.out).toContain("--once");
		const once = door(TRACKER, ["--once"]);
		expect(once.code).toBe(0);
	});
});

afterAll(() => {
	fx.cleanup();
	rmSync(PREFIX, { recursive: true, force: true });
});
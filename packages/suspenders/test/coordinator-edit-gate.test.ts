// test/coordinator-edit-gate.test.ts — W834 coordinator structural-edit
// gate: pure role/allowlist/root helpers + gate-level spawns (real
// `bun hooks/gate.ts pre-files` process, the gates.test.ts pattern).
// Fixtures live under the OS temp realpath — this gate has no /tmp
// exemption, and the root walk-up from the temp dir never reaches a real
// fleet checkout, so spawns resolve coordinator/lane deterministically.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	readdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	coordinatorDenyText,
	coordinatorWriteAllowed,
	fleetRootFor,
	sessionRole,
} from "../hooks/lib/coordinator-edit-gate.ts";

const tmp = mkdtempSync(
	join(realpathSync("/tmp"), "coord-edit-gate-"),
);
const root = join(tmp, "fleet"); // fleet-shaped fixture repo
mkdirSync(join(root, "packages", "suspenders"), { recursive: true });
const other = join(tmp, "plain"); // NOT fleet-shaped
mkdirSync(other, { recursive: true });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---- pure helpers ----

describe("fleetRootFor", () => {
	test("finds the monorepo shape at cwd and from below it", () => {
		expect(fleetRootFor(root)).toBe(root);
		expect(fleetRootFor(join(root, "packages", "belt"))).toBe(root);
	});
	test("plain dirs resolve empty — never gated", () => {
		expect(fleetRootFor(other)).toBe("");
	});
});

describe("coordinatorWriteAllowed", () => {
	test("the doc surface: *.md anywhere (docs/specs/plans/briefs)", () => {
		expect(coordinatorWriteAllowed(`${root}/docs/plan.md`)).toBe(true);
		expect(coordinatorWriteAllowed(`${root}/AGENTS.md`)).toBe(true);
		expect(coordinatorWriteAllowed(`${root}/.klh-brief.md`)).toBe(true);
		expect(coordinatorWriteAllowed(`${root}/docs/plan.MD`)).toBe(true);
	});
	test(".fleet/** runtime state", () => {
		expect(coordinatorWriteAllowed(`${root}/.fleet/state-x.md`)).toBe(true);
		expect(coordinatorWriteAllowed(`${root}/.fleet/brief-y.txt`)).toBe(true);
	});
	test("structural targets deny", () => {
		expect(coordinatorWriteAllowed(`${root}/src/main.ts`)).toBe(false);
		expect(coordinatorWriteAllowed(`${root}/.qlty/qlty.toml`)).toBe(false);
		expect(coordinatorWriteAllowed(`${root}/install.sh`)).toBe(false);
	});
});

describe("sessionRole", () => {
	const ENV = process.env.KLH_SESSION_ROLE;
	const withRole = (v: string | undefined, fn: () => void) => {
		if (v === undefined) delete process.env.KLH_SESSION_ROLE;
		else process.env.KLH_SESSION_ROLE = v;
		try {
			fn();
		} finally {
			if (ENV === undefined) delete process.env.KLH_SESSION_ROLE;
			else process.env.KLH_SESSION_ROLE = ENV;
		}
	};
	test("env marker lane wins", () => {
		withRole("lane", () => expect(sessionRole(other)).toBe("lane"));
	});
	test("explicit coordinator skips the walk", () => {
		withRole("coordinator", () => expect(sessionRole(root)).toBe("coordinator"));
	});
	test("absent marker outside any lane registry = coordinator", () => {
		withRole(undefined, () => expect(sessionRole(other)).toBe("coordinator"));
	});
});

describe("coordinatorDenyText", () => {
	test("carries the dispatch-it-instead redirect + kill switch", () => {
		const t = coordinatorDenyText("src/main.ts");
		expect(t).toContain("src/main.ts");
		expect(t).toContain("dispatch it instead");
		expect(t).toContain("SUSPENDERS_COORD_EDIT_GATE=0");
	});
});

// ---- gate-level: the real pre-files process ----

let n = 0;
/** Pre-write every target (raw fs writes take no governor lease), then
 *  spawn the real gate with a temp-file stdin payload. */
function spawnGate(
	cwd: string,
	target: string,
	env: Record<string, string>,
): { code: number; decision: string; reason: string } {
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, "placeholder\n");
	const payload = {
		tool_name: "Write",
		tool_input: { file_path: target, content: "export const x = 1;\n" },
		cwd,
		session_id: "coordgate-test",
	};
	const pf = join(tmp, `payload-${++n}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "pre-files"],
		{ stdin: Bun.file(pf), stdout: "pipe", stderr: "pipe", cwd: root, env },
	);
	let decision = "allow";
	let reason = "";
	try {
		const j = JSON.parse(r.stdout.toString()) as {
			hookSpecificOutput?: {
				permissionDecision?: string;
				permissionDecisionReason?: string;
			};
		};
		decision = j.hookSpecificOutput?.permissionDecision ?? "allow";
		reason = j.hookSpecificOutput?.permissionDecisionReason ?? "";
	} catch {}
	return { code: r.exitCode, decision, reason };
}

const envRole = (role?: string) => ({
	...process.env,
	SUSPENDERS_COORD_EDIT_GATE: "",
	KLH_SESSION_ROLE: role ?? "",
});

describe("coordinatorEditGate (gate-level)", () => {
	test("coordinator structural write denies with the redirect", () => {
		const r = spawnGate(
			root,
			join(root, "src", "main.ts"),
			envRole(undefined),
		);
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("coordinator-edit-gate");
	});
	test("coordinator doc write allows", () => {
		const r = spawnGate(root, join(root, "docs", "plan.md"), envRole(undefined));
		expect(r.decision).toBe("allow");
	});
	test("lane role marker passes on the same structural target", () => {
		const r = spawnGate(root, join(root, "src", "lane.ts"), envRole("lane"));
		expect(r.decision).toBe("allow");
	});
	test("kill switch disables the gate", () => {
		const r = spawnGate(root, join(root, "src", "off.ts"), {
			...envRole(undefined),
			SUSPENDERS_COORD_EDIT_GATE: "0",
		});
		expect(r.decision).toBe("allow");
	});
	test("non-fleet repo never gates", () => {
		const r = spawnGate(
			other,
			join(other, "src", "plain.ts"),
			envRole(undefined),
		);
		expect(r.decision).toBe("allow");
	});
	test("target outside the repo root is the ops surface — allowed", () => {
		const r = spawnGate(
			root,
			join(tmp, "machine-conf.env"),
			envRole(undefined),
		);
		expect(r.decision).toBe("allow");
	});
	test(".fleet/** allows even though it is not markdown", () => {
		const r = spawnGate(
			root,
			join(root, ".fleet", "brief-x.txt"),
			envRole(undefined),
		);
		expect(r.decision).toBe("allow");
	});
	test("every block appends to the denied-calls audit (incidents analog)", () => {
		const home = join(tmp, "home-audit");
		mkdirSync(join(home, ".cache"), { recursive: true });
		spawnGate(root, join(root, "src", "audited.ts"), {
			...envRole(undefined),
			HOME: home,
		});
		const dir = join(home, ".cache", "claude-governor");
		expect(readdirSync(dir)).toContain("denied-calls.jsonl");
		const lines = readFileSync(join(dir, "denied-calls.jsonl"), "utf8").trim();
		expect(lines).toContain("coordinator-edit-gate");
	});
});

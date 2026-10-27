// test/coordinator-edit-gate.test.ts — W834 coordinator structural-edit
// gate: pure role/allowlist/root helpers + gate-level spawns (real
// `bun hooks/gate.ts pre-files` process, the gates.test.ts pattern).
// Fixtures live under the OS temp realpath — this gate has no /tmp
// exemption, and temp dirs never carry a verified fleet identity (git root
// or installed prefix), so spawns resolve coordinator/lane deterministically
// (W1124.9).
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	readdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RECEIPT_FILE } from "../hooks/lib/install/harness-manifest.ts";
import {
	coordinatorDenyText,
	coordinatorWriteAllowed,
	fleetRootFor,
	sessionRole,
} from "../hooks/lib/gates/coordinator-edit-gate.ts";

const tmp = mkdtempSync(join(realpathSync("/tmp"), "coord-edit-gate-"));
const root = join(tmp, "fleet"); // fleet fixture repo — git-verified identity
mkdirSync(join(root, "packages", "suspenders", "hooks"), { recursive: true });
writeFileSync(
	join(root, "packages", "suspenders", "hooks", "gate.ts"),
	"export {};\n",
);
mkdirSync(join(root, "packages", "belt"), { recursive: true });
const other = join(tmp, "plain"); // NOT fleet-shaped, NOT a repo
mkdirSync(other, { recursive: true });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** git helper — spawn with the ambient env (bun spawn env replaces). */
function gitSync(args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	if (r.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	}
	return r.stdout.toString().trim();
}
gitSync(["init", root]);

// W1042: an enrolled EXTERNAL Git repo — no monorepo shape, but its
// .fleet/ carries control-plane claim state (the dispatch lane registry
// here), so the gate treats it as governed fleet surface.
const ext = join(tmp, "ext-enrolled");
mkdirSync(join(ext, ".fleet"), { recursive: true });
mkdirSync(join(ext, "src"), { recursive: true });
writeFileSync(join(ext, ".fleet", "lanes.json"), "[]\n");
gitSync(["init", ext]);

// ---- pure helpers ----

describe("fleetRootFor", () => {
	test("finds the monorepo shape at the git root, from cwd and below it", () => {
		expect(fleetRootFor(root)).toBe(root);
		expect(fleetRootFor(join(root, "packages", "belt"))).toBe(root);
	});
	test("plain dirs resolve empty — never gated", () => {
		expect(fleetRootFor(other)).toBe("");
	});
	test("W1124.9: temp dir under a shape lookalike ancestor is NOT fleet", () => {
		// The reported bug: a stale /private/tmp/packages/suspenders made
		// unrelated temp cwds classify Fleet and blocked valid edits. The
		// lookalike here EXISTS but no verified boundary backs it.
		mkdirSync(join(tmp, "packages", "suspenders"), { recursive: true });
		mkdirSync(join(tmp, "runner", "nested"), { recursive: true });
		expect(fleetRootFor(join(tmp, "runner", "nested"))).toBe("");
	});
	test("W1124.9: a real git repo WITHOUT the closure is not fleet", () => {
		const plain = join(tmp, "plain-repo");
		mkdirSync(plain, { recursive: true });
		gitSync(["init", plain]);
		expect(fleetRootFor(plain)).toBe("");
	});
	test("W1042: an enrolled external repo gates at its git toplevel", () => {
		expect(fleetRootFor(ext)).toBe(ext);
		expect(fleetRootFor(join(ext, "src"))).toBe(ext);
	});
	test("W1042: a linked worktree of an enrolled project gates at itself", () => {
		gitSync([
			"-C",
			ext,
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"--allow-empty",
			"-m",
			"init",
		]);
		const wt = join(tmp, "ext-worktree");
		gitSync(["-C", ext, "worktree", "add", "-b", "ext-w", wt]);
		// the worktree has NO .fleet of its own — the project evidence sits
		// at the main checkout root (one identity per common git dir, W624)
		expect(existsSync(join(wt, ".fleet"))).toBe(false);
		expect(fleetRootFor(wt)).toBe(wt);
	});
	test("W1042: the explicit ungoverned marker opts the project out", () => {
		const off = join(tmp, "ext-ungoverned");
		mkdirSync(join(off, ".fleet"), { recursive: true });
		writeFileSync(join(off, ".fleet", "lanes.json"), "[]\n");
		writeFileSync(join(off, ".fleet", "ungoverned"), "\n");
		gitSync(["init", off]);
		expect(fleetRootFor(off)).toBe("");
	});
	test("W1042: a hand-made .fleet without claim state is no evidence", () => {
		const look = join(tmp, "ext-lookalike");
		mkdirSync(join(look, ".fleet"), { recursive: true });
		writeFileSync(join(look, ".fleet", "notes.txt"), "not fleet state\n");
		gitSync(["init", look]);
		expect(fleetRootFor(look)).toBe("");
	});
	test("W1124.9: the real Fleet linked worktree resolves to itself", () => {
		const top = gitSync([
			"-C",
			import.meta.dir,
			"rev-parse",
			"--show-toplevel",
		]);
		expect(top).toBeTruthy();
		expect(fleetRootFor(top)).toBe(top);
		expect(fleetRootFor(join(top, "packages", "suspenders"))).toBe(top);
	});
	test("installed prefix + receipt is a fleet root; without receipt is not", () => {
		const prefix = join(tmp, "prefix");
		mkdirSync(prefix, { recursive: true });
		const prior = process.env.SUSPENDERS_PREFIX;
		process.env.SUSPENDERS_PREFIX = prefix;
		try {
			expect(fleetRootFor(join(prefix, "hooks"))).toBe("");
			writeFileSync(join(prefix, RECEIPT_FILE), "{}\n");
			expect(fleetRootFor(join(prefix, "hooks"))).toBe(prefix);
		} finally {
			if (prior === undefined) delete process.env.SUSPENDERS_PREFIX;
			else process.env.SUSPENDERS_PREFIX = prior;
		}
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
		withRole("coordinator", () =>
			expect(sessionRole(root)).toBe("coordinator"),
		);
	});
	test("absent marker outside any lane registry = coordinator", () => {
		withRole(undefined, () => expect(sessionRole(other)).toBe("coordinator"));
	});
	// W1041.2 review case 3: a native child of an interactive coordinator
	// inherits neither the lane marker nor a lanes.json registration, yet it
	// is an executor — the seam's agent fields classify it before the walk.
	test("native child of a coordinator is a lane, even over an inherited coordinator marker", () => {
		const child = {
			agent_id: "a1",
			agent_type: "claude",
			transcript_path: join(root, "no", "subagents", "a1.jsonl"),
		};
		withRole(undefined, () => expect(sessionRole(other, child)).toBe("lane"));
		withRole("coordinator", () =>
			expect(sessionRole(other, child)).toBe("lane"),
		);
		withRole(undefined, () =>
			expect(sessionRole(other, { agent_type: "claude" })).toBe("coordinator"),
		);
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
	createTarget = true,
): { code: number; decision: string; reason: string } {
	if (createTarget) {
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, "placeholder\n");
	}
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
	test("coordinator new structural target through a symlinked checkout denies", () => {
		const alias = join(tmp, "fleet-alias");
		symlinkSync(root, alias, "dir");
		// Neither the leaf nor its parent directories exist: resolve the
		// nearest existing ancestor without materializing the target first.
		const target = join(alias, "new-directory", "deeper", "new.ts");
		expect(existsSync(target)).toBe(false);
		const r = spawnGate(alias, target, envRole("coordinator"), false);
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("coordinator-edit-gate");
		expect(existsSync(target)).toBe(false);
	});
	test("coordinator structural write denies with the redirect", () => {
		const r = spawnGate(root, join(root, "src", "main.ts"), envRole(undefined));
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("coordinator-edit-gate");
	});
	test("coordinator doc write allows", () => {
		const r = spawnGate(
			root,
			join(root, "docs", "plan.md"),
			envRole(undefined),
		);
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
	test("W1042: coordinator structural write in an enrolled external repo denies", () => {
		const r = spawnGate(ext, join(ext, "src", "main.ts"), envRole(undefined));
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("coordinator-edit-gate");
	});
	test("W1042: enrolled external repo doc write allows (review/exploration surface)", () => {
		const r = spawnGate(ext, join(ext, "docs", "plan.md"), envRole(undefined));
		expect(r.decision).toBe("allow");
	});
	test("W1042: enrolled external repo lane role keeps the write surface", () => {
		const r = spawnGate(ext, join(ext, "src", "lane.ts"), envRole("lane"));
		expect(r.decision).toBe("allow");
	});
	test("W1042: a genuinely ungoverned repo never gates", () => {
		const plain = join(tmp, "plain-repo");
		mkdirSync(plain, { recursive: true });
		if (!existsSync(join(plain, ".git"))) gitSync(["init", plain]);
		const r = spawnGate(
			plain,
			join(plain, "src", "plain.ts"),
			envRole(undefined),
		);
		expect(r.decision).toBe("allow");
	});
	test("W1124.9: lookalike ancestor never gates a temp-dir write", () => {
		// end-to-end bug scenario: cwd under a shape lookalike (no git, no
		// installed identity) must reach the gate as NOT fleet — allow.
		const dir = join(tmp, "runner", "nested");
		const r = spawnGate(dir, join(dir, "scratch.ts"), envRole(undefined));
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

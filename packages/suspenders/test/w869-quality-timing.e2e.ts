// test/w869-quality-timing.test.ts — W869 lane checkout discipline +
// quality-timing: (c) the promoted lint classes (noNonNullAssertion,
// useLiteralKeys) refuse the WRITE deterministically (hooks/gates/files.ts),
// (a) location-vs-claim denies pre-write edits that land outside a claimed
// lane's registered worktree (hooks/gates/governor.ts), and (b) the merge
// ladder auto-fixes deferred cosmetic lint on merged files
// (hooks/lib/fleet-loop/merge.ts qltyFixMergedFiles — qlty check --fix plus
// the cached biome binary, because qlty 0.649 reports biome fixes without
// applying them).
import { expect, test } from "./pw";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promotedClassViolation } from "../hooks/gates/files.ts";
import { locationVsClaim } from "../hooks/gates/governor.ts";
import {
	qltyFixMergedFiles,
	biomeBin,
	biomeScratchConfig,
} from "../hooks/lib/fleet-loop/merge.ts";

test.setTimeout(30_000);

// ---- shared fixtures (tmpdir-based; fs-level, no gate leases) ---------------
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "w869-")));
test.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (cmd: string[], cwd: string): number =>
	Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" }).exitCode ?? 1;

/** A real git repo with a registered worktree that carries a lane context —
 * the exact shape a dispatch-created lane rides. */
function laneFixture(
	sid = "wt-lane",
	item = "W990",
): {
	repo: string;
	wt: string;
} {
	const repo = mkdtempSync(join(tmp, "repo-"));
	run(["git", "init", "-q", "-b", "main", repo], tmp);
	writeFileSync(join(repo, ".git", "w869-marker"), "x");
	run(["git", "config", "user.email", "t@t"], repo);
	run(["git", "config", "user.name", "t"], repo);
	run(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
	const wt = join(repo, ".worktrees", "W990");
	run(["git", "worktree", "add", "-q", "-b", "wtbranch", wt], repo);
	mkdirSync(join(wt, ".fleet"), { recursive: true });
	writeFileSync(
		join(wt, ".fleet", "lane-context.json"),
		JSON.stringify({ sid, item }),
	);
	return { repo, wt };
}

const hook = (cwd: string, _F: string) =>
	({ cwd, session_id: "probe-lane", transcript_path: "/nope.jsonl" }) as never;

// ============================== (c) promoted classes ==============================

test.describe("promotedClassViolation (W869 write-time blocks)", () => {
	test("non-null assertion (member + call shape) fires", () => {
		expect(promotedClassViolation("x.ts", "const k = a!.b;\n")).toContain(
			"noNonNullAssertion",
		);
		expect(promotedClassViolation("x.ts", "foo()!.bar();\n")).toContain(
			"noNonNullAssertion",
		);
	});
	test("computed string-key access + object property fire", () => {
		expect(promotedClassViolation("x.ts", 'const v = o["x"];\n')).toContain(
			"useLiteralKeys",
		);
		expect(
			promotedClassViolation("x.ts", 'const o = { ["k"]: 1 };\n'),
		).toContain("useLiteralKeys");
	});
	test("shapes biome never flags stay clean", () => {
		expect(
			promotedClassViolation("x.ts", "const v = o.x;\nconst w = a?.b;\n"),
		).toBeNull();
		expect(promotedClassViolation("x.ts", 'const v = o["0"];\n')).toBeNull(); // numeric key
		expect(promotedClassViolation("x.ts", 'const v = o["a-b"];\n')).toBeNull(); // dashed key
		expect(
			promotedClassViolation("x.ts", 'const t = x as ["a"];\n'),
		).toBeNull(); // type tuple
		expect(
			promotedClassViolation("x.ts", 'const a = ["p", "q"];\n'),
		).toBeNull(); // array literal
	});
	test("non-code extensions skip entirely", () => {
		expect(promotedClassViolation("x.md", "a!.b\n")).toBeNull();
		expect(promotedClassViolation("x.json", 'a["k"]\n')).toBeNull();
	});
	test("filesCheck refuses a promoted-class payload", () => {
		// lazily imported to keep the pure-matrix imports flat
		const { filesCheck } = require("../hooks/gates/files.ts") as {
			filesCheck: (h: never) => { kind: string; err?: string };
		};
		const f = join(tmp, "promoted.ts");
		writeFileSync(f, "export const z = 1;\n");
		const v = filesCheck({
			tool_name: "Write",
			tool_input: { file_path: f, content: "const k = a!.b;\n" },
		} as never);
		expect(v.kind).toBe("block");
		expect(v.err).toContain("PROMOTED CLASS");
	});
});

// ============================== (a) location-vs-claim ==============================

test.describe("locationVsClaim (W869 pre-write deny)", () => {
	const { repo, wt } = laneFixture();
	test("main-checkout edit from the worktree lane denies", () => {
		const v = locationVsClaim(
			hook(wt, join(repo, "leak.ts")),
			join(repo, "leak.ts"),
		);
		expect(v).not.toBeNull();
		expect(v?.msg).toContain("LOCATION-VS-CLAIM");
		expect(v?.item).toBe("W990");
	});
	test("own-worktree, companion-repo, and non-lane edits fail open", () => {
		expect(
			locationVsClaim(hook(wt, join(wt, "ok.ts")), join(wt, "ok.ts")),
		).toBeNull();
		const other = mkdtempSync(join(tmp, "other-repo-"));
		run(["git", "init", "-q", "-b", "main", other], tmp);
		expect(
			locationVsClaim(hook(wt, join(other, "x.ts")), join(other, "x.ts")),
		).toBeNull();
		expect(
			locationVsClaim(
				hook(join(repo, "sub"), join(repo, "x.ts")),
				join(repo, "x.ts"),
			),
		).toBeNull(); // no lane context — not a dispatched lane
	});
});

// ============================== (a2) governor-gate wiring ==============================

test.describe("governor gate denies pre-write (spawned, fixture HOME)", () => {
	test("worktree lane writing the shared checkout → deny + LOCATION-VS-CLAIM", () => {
		const HOME = mkdtempSync(join(tmp, "home-"));
		const { repo, wt } = laneFixture("spawn-lane", "W992");
		const payload = join(HOME, "hook.json");
		writeFileSync(
			payload,
			JSON.stringify({
				tool_name: "Write",
				tool_input: { file_path: join(repo, "leak.ts") },
				cwd: wt,
				session_id: "spawn-lane",
				transcript_path: "/nope.jsonl",
			}),
		);
		const p = Bun.spawnSync(
			["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "governor"],
			{
				cwd: wt,
				env: { ...process.env, HOME, KLH_SESSION_ROLE: "lane" },
				stdin: Bun.file(payload),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = p.stdout.toString();
		expect(out).toContain('"permissionDecision":"deny"');
		expect(out).toContain("LOCATION-VS-CLAIM");
		rmSync(HOME, { recursive: true, force: true });
	});
});

// ============================== (b) merge-time quality floor ==============================

test.describe("qltyFixMergedFiles (W869 merge-time autofix)", () => {
	test("no code files or no qlty → no-op", () => {
		expect(
			qltyFixMergedFiles({ repo: tmp, branch: "b/x", files: ["docs.md"] }),
		).toEqual({ fixed: false, head: null, left: 0 });
		expect(qltyFixMergedFiles({ repo: tmp, branch: "b/x", files: [] })).toEqual(
			{
				fixed: false,
				head: null,
				left: 0,
			},
		);
	});
	test("biomeBin resolves the qlty-cached binary; scratch config materializes", () => {
		expect(biomeScratchConfig()).not.toBeNull();
		expect(existsSync(join(biomeScratchConfig() ?? "", "biome.json"))).toBe(
			true,
		);
		// machine-local: the binary itself is present on any qlty provisioned
		// machine; a cache miss yields null (fail-open), never a throw
		const bin = biomeBin();
		expect(bin === null || existsSync(bin)).toBe(true);
	});
	test.skipIf(!biomeBin())(
		"linty merged file gets auto-fixed and committed on main",
		() => {
			const { repo } = laneFixture("fix-lane", "W991");
			// minimal qlty setup copied from the suspenders package config
			mkdirSync(join(repo, ".qlty"), { recursive: true });
			writeFileSync(join(repo, ".qlty", "qlty.toml"), readQltyToml());
			run(["git", "add", ".qlty"], repo);
			run(["git", "commit", "-q", "-m", "qlty setup"], repo);
			writeFileSync(
				join(repo, "linty.ts"),
				'const a = { b: 1 };\nexport const k = a!.b;\nconst o: Record<string, number> = { ["x"]: 1 };\nexport const u = k + o["x"];\n',
			);
			const r = qltyFixMergedFiles({
				repo,
				branch: "suspenders/W991",
				files: ["linty.ts"],
			});
			expect(r.fixed).toBe(true);
			expect(r.head).not.toBeNull();
			const fixed = Bun.spawnSync(["rg", "-n", "k =", join(repo, "linty.ts")]);
			const out = fixed.stdout.toString();
			expect(out).toContain("a?.b");
			expect(out).not.toContain("a!.b");
			const log = Bun.spawnSync(["git", "-C", repo, "log", "--oneline"]);
			expect(log.stdout.toString()).toContain("merge-time qlty autofix");
		},
	);
});

/** The real suspenders qlty.toml — the fixture needs the biome plugin the
 * same way the repo does (exit-99 setups skip silently). */
function readQltyToml(): string {
	return Bun.spawnSync([
		"cat",
		join(import.meta.dir, "..", ".qlty", "qlty.toml"),
	]).stdout.toString();
}

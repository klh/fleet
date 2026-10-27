// test/checkpoint.test.ts — W253: the rolling compaction checkpoint. Pure
// merge semantics + the three surfaces (CLI set/show, pre-compact auto-roll,
// session-start read-first line) against real spawned scripts in a temp HOME
// and temp checkpoint root.
import { expect, test } from "@playwright/test";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	existsSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractSections,
	renderCheckpoint,
	checkpointPath,
	slug,
} from "../hooks/lib/checkpoint.ts";

test.setTimeout(30_000);

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w253-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w253-repo-"));
const CKPTS = mkdtempSync(join(tmpdir(), "suspenders-w253-ckpt-"));

test.afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
	rmSync(CKPTS, { recursive: true, force: true });
});

// harness lane identity must not leak into the spawned hooks: a live
// SUSPENDERS_SID or a real buckle front trips gates meant for the real
// plane (W670 lesson — pin the operator knobs in the fixture env)
const env = (): Record<string, string> => {
	const e = { ...(process.env as Record<string, string>), HOME };
	delete e.SUSPENDERS_SID;
	delete e.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
	e.SUSPENDERS_BUCKLE_FRONT = "http://127.0.0.1:1";
	e.SUSPENDERS_BELT_ENV = join(HOME, "absent-belt.env");
	e.SUSPENDERS_CKPT_ROOT = CKPTS;
	return e;
};

const run = (
	script: string,
	args: string[],
	input: unknown,
): { out: string; err: string; code: number } => {
	const pf = join(HOME, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, typeof input === "string" ? input : JSON.stringify(input));
	const p = Bun.spawnSync(["bun", script, ...args], {
		cwd: REPO,
		env: env(),
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
	});
	rmSync(pf, { force: true });
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
};

const CLI = join(import.meta.dir, "..", "hooks", "bin", "checkpoint.ts");
const PRE = join(import.meta.dir, "..", "hooks", "pre-compact.ts");
const START = join(import.meta.dir, "..", "hooks", "session-start.ts");
const SID = "w253test-sess";
// spawns resolve projectIdentity() from cwd=REPO, which sits INSIDE the
// worktree — git walks up to the real common dir, so the slug is the
// project's, not REPO's. Derive the expected dir the same way.
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
const PDIR = join(CKPTS, slug(projectIdentity()));

// ---- pure helpers --------------------------------------------------------

test.describe("slug", () => {
	test("strips a .git tail (projectIdentity is the git common dir)", () => {
		expect(slug("/x/klh/suspenders/.git")).toBe("suspenders");
	});
	test("plain dir passes through", () => {
		expect(slug("/x/y/belt")).toBe("belt");
	});
});

test.describe("checkpointPath", () => {
	test("sid-safe + project-scoped path", () => {
		const p = checkpointPath("/x/klh/suspenders/.git", "abc#lane 1");
		expect(p.endsWith("/suspenders/abc_lane_1.md")).toBe(true);
		expect(p.startsWith("/tmp/suspenders-checkpoints/")).toBe(true);
	});
});

test.describe("extractSections", () => {
	test("pulls bullets, ignores prose", () => {
		const s = extractSections(
			[
				"# CHECKPOINT — x · y",
				"rolled: 2026-10-03 (gen 3, manual)",
				"",
				"## done",
				"- newest",
				"- older",
				"",
				"## next",
				"- next bullet",
			].join("\n"),
		);
		expect(s.done).toEqual(["newest", "older"]);
		expect(s.next).toEqual(["next bullet"]);
	});
	test("absent sections come back empty", () => {
		expect(extractSections("nothing here").done).toEqual([]);
	});
});

test.describe("renderCheckpoint", () => {
	test("conditional header lines + gen/trigger", () => {
		const md = renderCheckpoint({
			project: "/x/.git",
			sid: "s1",
			rolledIso: "ISO",
			gen: 2,
			head: "main @ abc",
			owned: "W1[READY] t",
			capsule: "",
			done: ["d1"],
			next: ["n1"],
			auto: "manual",
		});
		expect(md).toContain("rolled: ISO (gen 2, manual)");
		expect(md).toContain("branch: main @ abc");
		expect(md).toContain("owned: W1[READY] t");
	});
});

// ---- integration: the three surfaces -------------------------------------

test.describe("checkpoint CLI", () => {
	test("set rolls; show cats", () => {
		const r = run(
			CLI,
			["set", "--as", SID, "--note", "first done", "--next", "step one"],
			"",
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("gen 1");
		const p = join(PDIR, `${SID}.md`);
		expect(existsSync(p)).toBe(true);
		const body = readFileSync(p, "utf8");
		expect(body).toContain("- first done");
		expect(body).toContain("- step one");
		const s = run(CLI, ["show", "--as", SID], "");
		expect(s.out).toContain("- first done");
	});

	test("second set rolls: gen bumps, bullets accumulate newest-first", () => {
		run(CLI, ["set", "--as", SID, "--note", "second done"], "");
		const body = readFileSync(join(PDIR, `${SID}.md`), "utf8");
		expect(body).toContain("gen 2");
		const secs = extractSections(body);
		expect(secs.done[0]).toBe("second done");
		expect(secs.done).toContain("first done");
	});
});

test.describe("pre-compact hook", () => {
	test("rolls header with trigger, agent bullets survive", () => {
		const f = join(PDIR, `${SID}.md`);
		const before = extractSections(readFileSync(f, "utf8"));
		const r = run(PRE, [], {
			session_id: SID,
			transcript_path: "",
			trigger: "manual",
		});
		expect(r.code).toBe(0);
		const after = extractSections(readFileSync(f, "utf8"));
		expect(after.done).toEqual(before.done);
		expect(after.next).toEqual(before.next);
	});

	test("no session_id → silent no-op", () => {
		expect(run(PRE, [], { trigger: "auto" }).code).toBe(0);
	});
});

test.describe("session-start checkpoint line", () => {
	test("post-compact leads with the read-first directive", () => {
		const r = run(START, [], {
			session_id: SID,
			transcript_path: "",
			source: "compact",
		});
		expect(r.code).toBe(0);
		const first = r.out.split("\n")[0];
		expect(first.startsWith("CHECKPOINT ")).toBe(true);
		expect(first).toContain("FIRST ACTION");
	});

	test("no file → no checkpoint line", () => {
		const r = run(START, [], {
			session_id: "w253test-sess2",
			transcript_path: "",
			source: "startup",
		});
		expect(r.code).toBe(0);
		expect(r.out.startsWith("CHECKPOINT ")).toBe(false);
	});
});

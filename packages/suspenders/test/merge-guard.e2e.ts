import { expect, test } from "./pw";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedMerge } from "../hooks/lib/fleet-loop/merge-guard.ts";

const LOOP = join(import.meta.dir, "../hooks/bin/fleet-loop.ts");
const MERGE_LEAK = "/Users/kk/dev/m"; // scrub:allow
const repos: string[] = [];
const git = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};
function fixture(content: string, name = "change.ts") {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "fleet-merge-guard-")));
	repos.push(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.invalid");
	writeFileSync(join(repo, "base.ts"), "export const base = 1;\n");
	mkdirSync(join(repo, "packages/app"), { recursive: true });
	writeFileSync(join(repo, "packages/app/.keep"), "");
	git(repo, "add", "base.ts");
	git(repo, "add", "packages/app/.keep");
	git(repo, "commit", "-m", "base");
	const before = git(repo, "rev-parse", "HEAD").out;
	git(repo, "checkout", "-b", "suspenders/GUARD");
	writeFileSync(join(repo, name), content);
	git(repo, "add", "--", name);
	git(repo, "commit", "-m", "lane");
	git(repo, "checkout", "main");
	mkdirSync(join(repo, ".fleet"));
	writeFileSync(join(repo, ".fleet/lanes.json"), "[]");
	return { repo, before };
}
function ship(
	repo: string,
	ladder?: string,
	callerRepo = repo,
	approved = true,
) {
	// Exercise the real ladder, including exact DONE and independent review.
	// These fixtures previously stopped at unknown-item and never reached
	// the merge guard they purported to test.
	const env = {
		...process.env,
		HOME: join(repo, ".test-home"),
		GOVERNOR_STORE_URL: "",
		FLEET_UNTRACKED_GRACE_MS: "0",
	};
	const seeded = Bun.spawnSync(
		[
			"bun",
			"-e",
			`
		import {openStore,projectIdentity} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb/govdb.ts"))};
		import {reviewContext,publishReviewReceipt} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/gates/review-receipt.ts"))};
		const db=openStore(), project=projectIdentity(), c=reviewContext(process.cwd(),"suspenders/GUARD");
		db.query("INSERT OR REPLACE INTO work_items(project,id,title,state,result_sha,created_at,updated_at) VALUES (?,'GUARD','fixture','DONE',?,?,?)").run(project,c.commit,Date.now(),Date.now());
		db.run("CREATE TABLE IF NOT EXISTS work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)");
		db.query("INSERT INTO work_completion_records VALUES (?,'GUARD',?,'fixture-author')").run(project,c.commit);
		db.query("INSERT INTO sessions(sid,project,role,started_at,hb,state) VALUES ('fixture-reviewer',?,'reviewer',?,?,'DONE')").run(project,Date.now(),Date.now());
		if (${approved}) publishReviewReceipt(db,project,'GUARD',{version:1,commit:c.commit,base:c.base,instructions:c.instructions,reviewer:'fixture-reviewer',verdict:'PASS',blocking:[],evidence:'fixture independent review'});
		db.close();
	`,
		],
		{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
	);
	if (seeded.exitCode !== 0) throw new Error(seeded.stderr.toString());
	return Bun.spawnSync(
		[
			"bun",
			LOOP,
			"ship",
			"--repo",
			callerRepo,
			"--branch",
			"suspenders/GUARD",
			...(ladder ? ["--ladder", ladder] : []),
		],
		{
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}
function rejected(repo: string, before: string) {
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
	expect(git(repo, "branch", "--list", "suspenders/GUARD").out).not.toBe("");
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain("FAIL");
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).not.toContain(
		"MERGED",
	);
}
test.afterEach(() => {
	for (const repo of repos.splice(0))
		rmSync(repo, { recursive: true, force: true });
});

test("canonical ship defers unreviewed DONE without parking or pretending it landed", () => {
	const { repo, before } = fixture("export const valid = 1;\n");
	ship(repo, undefined, repo, false);
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
	const log = readFileSync(join(repo, ".fleet/loop.log"), "utf8");
	expect(log).toContain("independent review receipt missing");
	expect(log).not.toContain("PARKED");
	expect(log).not.toContain("MERGED");
});

test("clean Git merge cannot publish already committed conflict markers", () => {
	const { repo, before } = fixture(
		"<<<<<<< ours\nconst a=1;\n=======\nconst a=2;\n>>>>>>> theirs\n",
	);
	ship(repo);
	rejected(repo, before);
});
test("preflight refuses a branch that replaces substantial documentation with a stub", () => {
	const { repo } = fixture("export const valid = 1;\n");
	writeFileSync(
		join(repo, "README.md"),
		`${"Documented capability and contract.\n".repeat(230)}`,
	);
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "document baseline");
	const before = git(repo, "rev-parse", "HEAD").out;
	git(repo, "checkout", "suspenders/GUARD");
	git(repo, "reset", "--hard", "main");
	writeFileSync(join(repo, "README.md"), "beta\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "replace docs");
	git(repo, "checkout", "main");
	ship(repo);
	rejected(repo, before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"candidate removes",
	);
});
test("preflight rejects diff3 markers in a renamed-looking newline path", () => {
	const { repo, before } = fixture("||||||| base\n", "space and\nnewline.txt");
	ship(repo, 'git merge --no-ff {branch} -m "custom merge"');
	rejected(repo, before);
});
test("syntax-broken TypeScript is rejected without conflict markers", () => {
	const { repo, before } = fixture("export const broken = ;\n");
	ship(repo);
	rejected(repo, before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"syntax rejected",
	);
});
test("postflight isolates markers introduced by an immediately committing custom ladder", () => {
	const { repo, before } = fixture("export const valid = 1;\n");
	ship(
		repo,
		"git merge --no-ff {branch} -m custom && printf '<<<<<<< injected\\n' > injected.txt && git add injected.txt && git commit -m injected",
	);
	rejected(repo, before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"injected.txt",
	);
});
test("validation failure preserves unrelated staged and unstaged main changes", () => {
	const { repo, before } = fixture("<<<<<<< bad\n");
	writeFileSync(join(repo, "base.ts"), "export const base = 2;\n");
	git(repo, "add", "base.ts");
	writeFileSync(join(repo, "base.ts"), "export const base = 3;\n");
	const index = git(repo, "show", ":base.ts").out;
	ship(repo);
	rejected(repo, before);
	expect(git(repo, "show", ":base.ts").out).toBe(index);
	expect(readFileSync(join(repo, "base.ts"), "utf8")).toBe(
		"export const base = 3;\n",
	);
});

test("successful custom ladder preserves package cwd and unrelated dirty main", () => {
	const { repo, before } = fixture("export const valid = 1;\n");
	writeFileSync(join(repo, "base.ts"), "export const base = 2;\n");
	git(repo, "add", "base.ts");
	writeFileSync(join(repo, "base.ts"), "export const base = 3;\n");
	const index = git(repo, "show", ":base.ts").out;
	ship(
		repo,
		'test -f .keep && git merge --no-ff {branch} -m "package merge"',
		join(repo, "packages/app"),
	);
	expect(git(repo, "rev-parse", "HEAD").out).not.toBe(before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"MERGED",
	);
	expect(git(repo, "show", ":base.ts").out).toBe(index);
	expect(readFileSync(join(repo, "base.ts"), "utf8")).toBe(
		"export const base = 3;\n",
	);
	expect(readFileSync(join(repo, "change.ts"), "utf8")).toBe(
		"export const valid = 1;\n",
	);
});

test("commented TypeScript config follows JSONC syntax", () => {
	const { repo, before } = fixture(
		'{ // valid TypeScript config\n"compilerOptions": { "strict": true, },\n}\n',
		"tsconfig.json",
	);
	const result = ship(repo);
	if (git(repo, "rev-parse", "HEAD").out === before)
		throw new Error(
			`ship did not publish: ${result.stderr.toString().slice(-1500)}\n${readFileSync(join(repo, ".fleet/loop.log"), "utf8").slice(-3500)}`,
		);
	expect(git(repo, "rev-parse", "HEAD").out).not.toBe(before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"MERGED",
	);
});

test("malformed ordinary JSON is rejected", () => {
	const { repo, before } = fixture('{ "name": }\n', "package.json");
	ship(repo);
	rejected(repo, before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"syntax rejected",
	);
});

test("lib extraction (shrink + added file carrying the lines) is not file loss", () => {
	// W1302.4: a 262-line helper shrank to a stub while the moved lines
	// reappeared in a new lib file — the M-filter shrink rule read that as
	// deletion and false-FAILed the branch three times, parking it.
	const { repo } = fixture("export const valid = 1;\n");
	const body = Array.from(
		{ length: 230 },
		(_, i) => `export const moved${i} = ${i};\n`,
	).join("");
	mkdirSync(join(repo, "tests/helpers"), { recursive: true });
	writeFileSync(join(repo, "tests/helpers/old.ts"), body);
	git(repo, "add", "tests/helpers/old.ts");
	git(repo, "commit", "-m", "seed helper");
	const seeded = git(repo, "rev-parse", "HEAD").out;
	git(repo, "branch", "-D", "suspenders/GUARD");
	git(repo, "checkout", "-b", "suspenders/GUARD");
	mkdirSync(join(repo, "lib"), { recursive: true });
	writeFileSync(
		join(repo, "lib/new.ts"),
		`// extracted\n${body}export const tail = 1;\n`,
	);
	writeFileSync(join(repo, "tests/helpers/old.ts"), "export const stub = 0;\n");
	git(repo, "add", "lib/new.ts");
	git(repo, "add", "tests/helpers/old.ts");
	git(repo, "commit", "-m", "extract");
	git(repo, "checkout", "main");
	ship(repo);
	expect(git(repo, "rev-parse", "HEAD").out).not.toBe(seeded);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"MERGED",
	);
});

test("shrink whose added sibling does not carry the lines still refuses", () => {
	const { repo } = fixture("export const valid = 1;\n");
	const body = Array.from(
		{ length: 230 },
		(_, i) => `export const gone${i} = ${i};\n`,
	).join("");
	writeFileSync(join(repo, "real.ts"), body);
	git(repo, "add", "real.ts");
	git(repo, "commit", "-m", "seed");
	const seeded = git(repo, "rev-parse", "HEAD").out;
	git(repo, "branch", "-D", "suspenders/GUARD");
	git(repo, "checkout", "-b", "suspenders/GUARD");
	writeFileSync(join(repo, "real.ts"), "export const stub = 0;\n");
	writeFileSync(join(repo, "unrelated.ts"), "export const u = 1;\n");
	git(repo, "add", "real.ts");
	git(repo, "add", "unrelated.ts");
	git(repo, "commit", "-m", "shrink");
	git(repo, "checkout", "main");
	ship(repo);
	rejected(repo, seeded);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"candidate removes",
	);
});

test("one added copy cannot cancel repeated removed lines", () => {
	const { repo } = fixture("export const valid = 1;\n");
	const repeated = "// repeated source line\n";
	writeFileSync(join(repo, "real.ts"), repeated.repeat(230));
	git(repo, "add", "real.ts");
	git(repo, "commit", "-m", "seed repeated lines");
	const seeded = git(repo, "rev-parse", "HEAD").out;
	git(repo, "branch", "-D", "suspenders/GUARD");
	git(repo, "checkout", "-b", "suspenders/GUARD");
	writeFileSync(join(repo, "real.ts"), "export const stub = 0;\n");
	writeFileSync(join(repo, "added.ts"), `${repeated}export const kept = 1;\n`);
	git(repo, "add", "real.ts", "added.ts");
	git(repo, "commit", "-m", "remove repeated lines");
	git(repo, "checkout", "main");
	ship(repo);
	rejected(repo, seeded);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"candidate removes",
	);
});

test("preparation filesystem failures return rejection without throwing", () => {
	const { repo, before } = fixture("export const valid = 1;\n");
	rmSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet"), "blocking file");
	const result = guardedMerge({
		repo,
		callerRepo: repo,
		branch: "suspenders/GUARD",
		timeoutMs: 10_000,
	});
	expect(result.code).toBe(1);
	expect(result.tail).toContain("preparation failed");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("option-looking branch is rejected before any ladder executes", () => {
	const { repo, before } = fixture("export const valid = 1;\n");
	const result = guardedMerge({
		repo,
		callerRepo: repo,
		branch: "--help",
		ladder: "touch should-not-run",
		timeoutMs: 10_000,
	});
	expect(result.code).toBe(1);
	expect(result.tail).toContain("unsafe ladder branch");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("preflight scrub denies a home-path leak in the lane content", () => {
	const { repo, before } = fixture(`export const p = "${MERGE_LEAK}";\n`);
	ship(repo);
	rejected(repo, before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"scrub findings",
	);
});

test("postflight scrub denies a leak a committing ladder injects", () => {
	const { repo, before } = fixture("export const valid = 1;\n");
	ship(
		repo,
		`git merge --no-ff {branch} -m custom && printf '%s\\n' ${JSON.stringify(`${MERGE_LEAK} cache`)} > injected.md && git add injected.md && git commit -m injected`,
	);
	rejected(repo, before);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"injected.md",
	);
});

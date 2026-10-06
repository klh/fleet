import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	flagIntegratedCode,
	oversizedMergedFiles,
} from "../hooks/lib/decomposition.ts";
const scratch: string[] = [];
afterEach(() => {
	for (const path of scratch.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "fleet-decomposition-"));
	scratch.push(repo);
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString().trim();
	};
	git("init", "-b", "main");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	const write = (path: string, lines: number, trailing = true) =>
		writeFileSync(
			join(repo, path),
			`${Array.from({ length: lines }, (_, n) => `// ${n}`).join("\n")}${trailing ? "\n" : ""}`,
		);
	const commit = () => {
		git("add", ".");
		git("commit", "-m", "fixture");
		return git("rev-parse", "HEAD");
	};
	write("target.ts", 1000);
	const base = commit();
	return { repo, git, write, commit, base };
}
test("soft threshold inspects merged committed code, excludes generated and deleted files", () => {
	const f = fixture();
	f.write("target.ts", 1500);
	let tip = f.commit();
	expect(oversizedMergedFiles(f.repo, f.base, tip)).toEqual([]);
	f.write("target.ts", 1501, false);
	mkdirSync(join(f.repo, "vendor"));
	f.write("vendor/copied.ts", 2000);
	f.write("notes.md", 2000);
	tip = f.commit();
	f.write("target.ts", 1); // dirty checkout cannot disguise merged oversize
	expect(oversizedMergedFiles(f.repo, f.base, tip)).toMatchObject([
		{ path: "target.ts", lines: 1501 },
	]);
	f.git("rm", "-f", "target.ts");
	tip = f.commit();
	expect(oversizedMergedFiles(f.repo, f.base, tip)).toEqual([]);
});
test("combined lane changes are measured on the merged main version", () => {
	const f = fixture();
	const baseBody = `${Array.from({ length: 1000 }, (_, n) => `// ${n}`).join("\n")}\n`;
	f.git("checkout", "-b", "agent-a", f.base);
	writeFileSync(
		join(f.repo, "target.ts"),
		`${"// prefix\n".repeat(300)}${baseBody}`,
	);
	const first = f.commit();
	f.git("checkout", "-b", "agent-b", f.base);
	writeFileSync(
		join(f.repo, "target.ts"),
		`${baseBody}${"// suffix\n".repeat(300)}`,
	);
	f.commit();
	f.git("checkout", "main");
	f.git("merge", "--no-ff", "agent-a", "-m", "integrate a");
	f.git("merge", "--no-ff", "agent-b", "-m", "integrate b");
	const merged = f.git("rev-parse", "HEAD");
	expect(oversizedMergedFiles(f.repo, f.base, merged, first)).toMatchObject([
		{ path: "target.ts", lines: 1600 },
	]);
});
test("flags are durable, active follow-up is reused, and dry run writes nothing", () => {
	const f = fixture();
	f.write("target.ts", 1501);
	const after = f.commit();
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,title TEXT,state TEXT); CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER); CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	let queued = 0;
	const options = {
		repo: f.repo,
		before: f.base,
		after,
		source: "test",
		db,
		enqueue: (title: string, desc: string) => {
			queued++;
			expect(desc).toContain("purpose-named subdirectory");
			expect(desc).toContain("import them");
			const project = f.git("rev-parse", "--absolute-git-dir");
			db.query("INSERT INTO work_items VALUES(?,?,?,'READY')").run(
				project,
				"W1",
				title,
			);
			return "W1";
		},
	};
	flagIntegratedCode({ ...options, dryRun: true });
	expect(queued).toBe(0);
	flagIntegratedCode(options);
	flagIntegratedCode(options);
	writeFileSync(join(f.repo, "README.md"), "unrelated update");
	flagIntegratedCode({ ...options, after: f.commit() });
	expect(queued).toBe(1);
	expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
	expect(db.query("SELECT value FROM facts").get()).toMatchObject({
		value: expect.stringContaining('"work":"W1"'),
	});
	db.close();
});

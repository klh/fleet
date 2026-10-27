import { expect, test } from "@playwright/test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLawVerdict } from "../hooks/lib/import-law.ts";
import {
	drainCleanup,
	fixture,
	summary,
} from "./helpers/work-completion-fixtures.ts";

test.afterEach(() => drainCleanup());

const gitIn = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(p.exitCode).toBe(0);
	return p.stdout.toString().trim();
};

// the ambient env must never disable the gate the test is proving
const unknob = (f: ReturnType<typeof fixture>) => {
	delete f.env.SUSPENDERS_IMPORT_LAW;
};

const writeReach = (repo: string, rel: string, spec: string) => {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(
		abs,
		`import { w } from ${JSON.stringify(spec)};\nexport const r = w;\n`,
	);
};
const writeFileIn = (repo: string, rel: string, body: string) => {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
};

test("done refuses a closing diff that adds a relative reach-in (W1302.4)", () => {
	const f = fixture();
	unknob(f);
	writeReach(f.repo, "packages/belt/src/reach.ts", "../../buckle/w.ts");
	writeFileIn(f.repo, "packages/buckle/w.ts", "export const w = 1;\n");
	gitIn(f.repo, "add", "-A");
	gitIn(f.repo, "commit", "-m", "reach across the boundary");
	const sha = gitIn(f.repo, "rev-parse", "HEAD");
	const done = f.work("done", f.id, "--sha", sha, "--summary", summary);
	expect(done.code).toBe(2);
	expect(done.err).toContain("import-law (W1302.4)");
	expect(done.err).toContain("packages/belt/src/reach.ts");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("ratchet passes inherited reach-ins and legal @klh imports (W1302.4)", () => {
	const f = fixture();
	unknob(f);
	// a reach-in that predates the claim baseline is inherited, never new
	writeReach(f.repo, "packages/belt/src/legacy.ts", "../../buckle/w.ts");
	writeFileIn(f.repo, "packages/buckle/w.ts", "export const w = 1;\n");
	gitIn(f.repo, "add", "-A");
	gitIn(f.repo, "commit", "-m", "inherited reach-in");
	const inherited = gitIn(f.repo, "rev-parse", "HEAD");
	// the lane context baseline moves to the inherited edge's commit
	const contextPath = join(f.repo, ".fleet", "lane-context.json");
	const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
		baseline: string;
	};
	context.baseline = inherited;
	writeFileSync(contextPath, JSON.stringify(context));
	// the closing diff: a legal package-name import + a clean file
	// (spec split-string: the W649 regex scanner scans THIS file too)
	writeFileIn(
		f.repo,
		"packages/belt/src/fixed.ts",
		['import { w } from "@klh/', 'buckle";\nexport const r = w;\n'].join(""),
	);
	writeFileSync(
		join(f.repo, "packages", "belt", "src", "clean.ts"),
		"export const c = 1;\n",
	);
	gitIn(f.repo, "add", "-A");
	gitIn(f.repo, "commit", "-m", "legal imports only");
	const done = f.work(
		"done",
		f.id,
		"--sha",
		gitIn(f.repo, "rev-parse", "HEAD"),
		"--summary",
		summary,
	);
	expect(done.code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("DONE");
});

test("importLawVerdict — per-edge ratchet, fail-closed base, unparseable refuse", () => {
	const repo = rmAfter(mkdtempIn());
	const git = (...args: string[]) => gitIn(repo, ...args);
	git("init");
	git("config", "user.name", "Test");
	git("config", "user.email", "t@e.invalid");
	writeReach(repo, "packages/x/a.ts", "../y/b.ts");
	writeFileIn(repo, "packages/y/b.ts", "export const b = 1;\n");
	git("add", "-A");
	git("commit", "--allow-empty", "-m", "base with inherited reach-in");
	const base = git("rev-parse", "HEAD");
	// same file gains a SECOND reach-in — only the new edge refuses
	const withSecond = [
		'import { w } from "../y/b.ts";',
		'import { v } from "../y/c.ts";',
		"export const r = [w, v];",
		"",
	].join("\n");
	writeFileSync(join(repo, "packages", "x", "a.ts"), withSecond);
	git("add", "-A");
	git("commit", "-m", "add a second reach-in");
	const sha = git("rev-parse", "HEAD");
	const v = (o: Partial<Parameters<typeof importLawVerdict>[0]> = {}) =>
		importLawVerdict({
			repo,
			paths: ["packages/x/a.ts"],
			baseRef: base,
			sha,
			disabled: false,
			...o,
		});
	const refused = v();
	expect(refused.ok).toBe(false);
	expect(refused.newEdges).toEqual([
		"packages/x/a.ts: x/a.ts -> y (../y/c.ts)",
	]);
	// the inherited edge alone passes
	expect(v({ sha: base }).ok).toBe(true);
	// no base ref: nothing can be proven inherited — fail-closed
	expect(v({ baseRef: null }).ok).toBe(false);
	// unparseable closing blob refuses
	writeFileSync(join(repo, "packages", "x", "a.ts"), "this is not <<< ts");
	git("add", "-A");
	git("commit", "-m", "unparseable");
	expect(v({ sha: git("rev-parse", "HEAD") }).ok).toBe(false);
	// non-package and non-ts paths never enter the verdict
	expect(
		importLawVerdict({
			repo,
			paths: ["docs/x.ts", "packages/x/readme.md"],
			baseRef: null,
			sha,
			disabled: false,
		}).ok,
	).toBe(true);
});

const mkdtempIn = () => mkdtempSync(join(tmpdir(), "w1302-import-law-"));
const rmAfter = (dir: string) => {
	toClean.push(dir);
	return dir;
};
const toClean: string[] = [];
process.on("exit", () => {
	for (const dir of toClean) rmSync(dir, { recursive: true, force: true });
});

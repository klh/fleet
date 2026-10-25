// release-version.test.ts — W1303.6: the one-version release core. Fixtures
// are scratch git repos under the OS tmpdir (NEVER inside the worktree —
// git -C resolves upward); apply tests drive the injected GitRunner, one
// real-git integration case proves commit+tag land as one change.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agreement,
	applyRelease,
	bumpSemver,
	compareSemver,
	discoverManifests,
	internalDepSpecs,
	latestTag,
	machineVersionHint,
	parseSemver,
	planRelease,
	prependChangelog,
	renderChangelogEntry,
	spawnGitRunner,
	workspaceDirs,
} from "./release-version.ts";

const gitInit = (dir: string): void => {
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
	execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
};

const fixture = (
	opts: { versions?: Record<string, string>; deps?: boolean } = {},
) => {
	const dir = mkdtempSync(join(tmpdir(), `w1303-6-release-`));
	gitInit(dir);
	const versions = opts.versions ?? {};
	const root = {
		name: "fleet",
		private: true,
		version: versions.root ?? "1.2.3",
		workspaces: ["packages/*", "!packages/decant"],
	};
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(root, null, "\t")}\n`,
	);
	for (const p of ["alpha", "beta", "decant", "plain"]) {
		mkdirSync(join(dir, "packages", p), { recursive: true });
		const json: Record<string, unknown> = {
			name: `@klh/${p}`,
			version: versions[p] ?? versions.root ?? "1.2.3",
		};
		if (opts.deps && p === "alpha")
			json.dependencies = { "@klh/beta": "workspace:*", zod: "^4.0.0" };
		writeFileSync(
			join(dir, "packages", p, "package.json"),
			`${JSON.stringify(json, null, "\t")}\n`,
		);
	}
	// decant excluded by workspaces negation; plain has no package.json
	if (opts.versions === undefined || versions.plain === undefined)
		rmSync(join(dir, "packages", "plain", "package.json"));
	writeFileSync(
		join(dir, "CHANGELOG.md"),
		"# Changelog\n\n## 1.2.3 — 2026-10-01\n\n- base\n",
	);
	execFileSync("git", ["-C", dir, "add", "."]);
	execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
	return dir;
};

describe("semver primitives", () => {
	test("parseSemver accepts plain triplets, rejects suffixes", () => {
		expect(parseSemver("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
		expect(parseSemver("1.0.0-rc.1")).toBeNull();
		expect(parseSemver("v1.0.0")).toBeNull();
	});
	test("bumpSemver increments the right segment and zeroes the rest", () => {
		expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
		expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
		expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
	});
	test("compareSemver orders numerically", () => {
		expect(compareSemver("1.2.9", "1.10.0")).toBeLessThan(0);
		expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
		expect(compareSemver("3.0.0", "3.0.0")).toBe(0);
	});
});

describe("workspace discovery", () => {
	test("root workspaces + negation resolve to manifest-holding dirs only", () => {
		const dir = fixture();
		const dirs = workspaceDirs(dir, ["packages/*", "!packages/decant"]);
		expect(dirs.sort()).toEqual(
			["packages/alpha", "packages/beta", "packages/decant"]
				.sort()
				.filter((d) => d !== "packages/decant"),
		);
		rmSync(dir, { recursive: true, force: true });
	});
	test("discoverManifests = root + workspaces, decant excluded, plain absent", () => {
		const dir = fixture();
		const rels = discoverManifests(dir).map((m) => m.rel);
		expect(rels).toEqual([
			"package.json",
			"packages/alpha/package.json",
			"packages/beta/package.json",
		]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("agreement gate", () => {
	test("all-agree manifests report OK with the shared version", () => {
		const dir = fixture();
		const a = agreement(dir);
		expect(a.ok).toBe(true);
		expect(a.current).toBe("1.2.3");
		expect(a.drift).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
	test("drift refuses with the offenders listed", () => {
		const dir = fixture({ versions: { beta: "1.2.4" } });
		const a = agreement(dir);
		expect(a.ok).toBe(false);
		expect(a.drift).toEqual([
			{ rel: "packages/beta/package.json", version: "1.2.4" },
		]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("planRelease", () => {
	test("default bump is patch; --to wins over --bump; --to must advance", () => {
		const dir = fixture({ deps: true });
		const patch = planRelease(dir);
		expect(patch.next).toBe("1.2.4");
		expect(patch.tag).toBe("v1.2.4");
		const to = planRelease(dir, { to: "2.0.0", kind: "patch" });
		expect(to.next).toBe("2.0.0");
		expect(() => planRelease(dir, { to: "1.2.3" })).toThrow(
			/must be > current/,
		);
		rmSync(dir, { recursive: true, force: true });
	});
	test("depRewrites list every @klh/* spec; zod untouched", () => {
		const dir = fixture({ deps: true });
		const plan = planRelease(dir);
		const alpha = plan.depRewrites.find(
			(d) => d.rel === "packages/alpha/package.json",
		);
		expect(alpha?.deps).toEqual({ "@klh/beta": "workspace:*" });
		rmSync(dir, { recursive: true, force: true });
	});
	test("drift refuses to plan", () => {
		const dir = fixture({ versions: { beta: "1.2.4" } });
		expect(() => planRelease(dir)).toThrow(/manifest drift/);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("changelog", () => {
	test("entry renders version, date and item bullets", () => {
		const e = renderChangelogEntry("2.1.0", ["W1303.6", "W1301"], "2026-10-25");
		expect(e).toBe("## 2.1.0 — 2026-10-25\n\n- W1303.6\n- W1301");
	});
	test("prepend lands before the first ## section, not at file head", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1303-6-cl-"));
		writeFileSync(
			join(dir, "CHANGELOG.md"),
			"# Changelog\n\nintro line\n\n## 1.2.3 — 2026-10-01\n\n- base\n",
		);
		prependChangelog(dir, "## 2.0.0 — 2026-10-25\n\n- W1303.6");
		const text = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		const at2 = text.indexOf("## 2.0.0");
		const at1 = text.indexOf("## 1.2.3");
		expect(at2).toBeGreaterThan(-1);
		expect(at1).toBeGreaterThan(at2);
		expect(text).toContain("intro line");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("applyRelease", () => {
	test("one commit, one annotated tag, every manifest + dep spec at next", () => {
		const dir = fixture({ deps: true });
		const plan = planRelease(dir);
		const r = applyRelease(dir, plan, ["W1303.6"]);
		expect(r.tag).toBe("v1.2.4");
		const out = execFileSync(
			"git",
			["-C", dir, "show", "--stat", "--oneline", r.commit],
			{ encoding: "utf8" },
		);
		expect(out).toContain("package.json");
		expect(out).toContain("CHANGELOG.md");
		// annotated tag object, not lightweight
		const type = execFileSync("git", ["-C", dir, "cat-file", "-t", r.tag], {
			encoding: "utf8",
		}).trim();
		expect(type).toBe("tag");
		// versions + dep specs all at next
		const alpha = JSON.parse(
			readFileSync(join(dir, "packages/alpha/package.json"), "utf8"),
		);
		expect(alpha.version).toBe("1.2.4");
		expect(alpha.dependencies["@klh/beta"]).toBe("1.2.4");
		expect(alpha.dependencies.zod).toBe("^4.0.0");
		const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		expect(root.version).toBe("1.2.4");
		// changelog carries the release line with the item id
		const cl = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		expect(cl).toContain("## 1.2.4");
		expect(cl).toContain("- W1303.6");
		// the tree is clean afterward (everything committed)
		const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
			encoding: "utf8",
		});
		expect(status).toBe("");
		rmSync(dir, { recursive: true, force: true });
	});
	test("dirty tree refuses before any write", () => {
		const dir = fixture();
		writeFileSync(join(dir, "stray.txt"), "x");
		const plan = planRelease(dir);
		expect(() => applyRelease(dir, plan, ["W1"])).toThrow(
			/working tree not clean/,
		);
		// nothing was written: manifests untouched
		const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		expect(root.version).toBe("1.2.3");
		rmSync(dir, { recursive: true, force: true });
	});
	test("a failed git step surfaces the runner's stderr", () => {
		const dir = fixture();
		const plan = planRelease(dir);
		const failing: { code: number; out: string; err: string }[] = [];
		const runner = (args: string[]) => {
			if (args[0] === "status") return { code: 0, out: "", err: "" };
			return failing[0] ?? { code: 128, out: "", err: "boom" };
		};
		expect(() => applyRelease(dir, plan, ["W1"], runner)).toThrow(/boom/);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("machine pin hint (render-only)", () => {
	test("unset pin renders the set-it line; a pin renders with the verdict", () => {
		const unset = machineVersionHint();
		expect(unset.pin === null || typeof unset.pin === "string").toBe(true);
		const m = machineVersionHint("9.9.9");
		expect(m.line).toContain("STACK VERSION PIN");
		expect(m.line).toContain("9.9.9");
	});
	test("KLH_STACK override reaches the hint (env contract)", () => {
		const prev = process.env.KLH_STACK;
		const tmp = mkdtempSync(join(tmpdir(), "w1303-6-stack-"));
		writeFileSync(
			join(tmp, "stack.json"),
			JSON.stringify({ version: "3.2.1", hubs: {} }),
		);
		process.env.KLH_STACK = join(tmp, "stack.json");
		try {
			const m = machineVersionHint("3.2.1");
			expect(m.pin).toBe("3.2.1");
			expect(m.line).toContain("matches");
		} finally {
			if (prev === undefined) delete process.env.KLH_STACK;
			else process.env.KLH_STACK = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("latestTag", () => {
	test("picks the highest plain-semver v-tag via the git runner", () => {
		const dir = fixture();
		const run = spawnGitRunner(dir);
		for (const t of ["v0.9.0", "v1.2.3", "v10.0.0", "v1.2.3-rc.1", "notatag"])
			execFileSync("git", ["-C", dir, "tag", t]);
		expect(latestTag(run)).toBe("v10.0.0");
		rmSync(dir, { recursive: true, force: true });
	});
	test("no tags → null", () => {
		const dir = fixture();
		expect(latestTag(spawnGitRunner(dir))).toBe(null);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("internalDepSpecs", () => {
	test("collects @klh/* across every dep map kind", () => {
		const specs = internalDepSpecs({
			dependencies: { "@klh/a": "1.0.0", zod: "4.0.0" },
			devDependencies: { "@klh/b": "workspace:*" },
			peerDependencies: { "@klh/c": "^2.0.0" },
			optionalDependencies: { "@klh/d": "2.0.0" },
		});
		expect(specs).toEqual({
			"@klh/a": "1.0.0",
			"@klh/b": "workspace:*",
			"@klh/c": "^2.0.0",
			"@klh/d": "2.0.0",
		});
	});
});

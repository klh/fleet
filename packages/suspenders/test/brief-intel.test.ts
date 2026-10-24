// test/brief-intel.test.ts — W254: pointer-grade brief injection. Covered:
// code-shaped term extraction, done-criteria digest, the W113 gates (small
// repo, spec-carried paths), anchor extraction from real rg hits, and the
// renderIntel composition rules (no headers without content).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	briefIntel,
	doneDigest,
	missionTerms,
	renderIntel,
	SMALL_REPO_FILES,
} from "../hooks/lib/lanes/brief-intel.ts";

// scratch repo with real files for rg to anchor against
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w254-intel-repo-"));
const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(
	join(REPO, "src", "work.ts"),
	"export const show = 1;\nexport const composeBrief = 2;\n",
);
writeFileSync(join(REPO, "src", "loop.ts"), "export const dispatchLoop = 3;\n");
writeFileSync(join(REPO, "README.md"), "x");
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
g(["add", "-A"]);
g(["commit", "-m", "base"]);

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("missionTerms", () => {
	test("keeps code-shaped tokens, drops prose", () => {
		const t = missionTerms(
			"brief template carries file-map + line anchors + doneDigest (pointer-grade injection, gated on repo size per W113) in hooks/lib/x.ts",
		);
		expect(t).toContain("file-map");
		expect(t).toContain("doneDigest");
		expect(t).toContain("W113");
		expect(t).toContain("hooks/lib/x.ts");
		for (const w of ["template", "carries", "anchors", "brief"])
			expect(t).not.toContain(w);
	});

	test("dedupes case-insensitively and caps at MAX_TERMS", () => {
		const t = missionTerms(
			"composeBrief COMPOSEBRIEF composeBrief camelCase snake_case kebab-case a.b.ts path/one/x.ts path/two/y.ts path/three/z.ts path/four/w.ts path/five/v.ts path/six/u.ts path/seven/t.ts path/eight/s.ts path/nine/r.ts path/ten/q.ts path/eleven/p.ts",
		);
		expect(t.filter((x) => x.toLowerCase() === "composebrief")).toHaveLength(1);
		expect(t.length).toBeLessThanOrEqual(10);
	});
});

describe("doneDigest", () => {
	test("extracts completion-criteria sentences, drops prose", () => {
		const d = doneDigest(
			"Add the knob. Done when gates pass green on the touched files. Ships a digest.",
		);
		expect(d).toEqual(["Done when gates pass green on the touched files."]);
	});

	test("dedupes, caps at 5, truncates long segments", () => {
		const d = doneDigest(
			Array.from(
				{ length: 8 },
				(_, i) => `Verify claim ${i + 1} with real output.`,
			).join(" "),
		);
		expect(d).toHaveLength(5);
		for (const s of d) expect(s.length).toBeLessThanOrEqual(160);
	});
});

describe("briefIntel", () => {
	test("small repo skips with the W113 tax reason", () => {
		const intel = briefIntel(REPO, "wire composeBrief into dispatchLoop");
		expect(intel.skip).toContain("W113 tax gate");
		expect(intel.fileMap).toEqual([]);
		expect(intel.doneDigest).toEqual([]);
	});

	test("builds a ranked file map with line anchors past the gate", () => {
		const intel = briefIntel(REPO, "wire composeBrief into dispatchLoop", {
			smallRepo: 2,
		});
		expect(intel.skip).toBeUndefined();
		expect(intel.fileMap.length).toBeGreaterThan(0);
		const all = intel.fileMap.join("\n");
		expect(all).toContain("src/work.ts:2");
		expect(all).toContain("src/loop.ts:1");
		expect(all).toContain("matched: composeBrief");
	});

	test("mission text naming 3+ paths skips as spec-carried", () => {
		const intel = briefIntel(
			REPO,
			"migrate hooks/a/b.ts hooks/c/d.ts hooks/e/f.ts and verify",
			{ smallRepo: 2 },
		);
		expect(intel.skip).toBe("mission already names 3 paths");
	});

	test("prose-only missions skip with no searchable terms", () => {
		const intel = briefIntel(REPO, "polish every sentence of the readme", {
			smallRepo: 2,
		});
		expect(intel.skip).toBe("no searchable terms in the mission text");
	});

	test("SMALL_REPO_FILES separates the W113 calibration points", () => {
		expect(SMALL_REPO_FILES).toBeGreaterThan(38);
		expect(SMALL_REPO_FILES).toBeLessThan(268);
	});
});

describe("renderIntel", () => {
	test("renders both sections with content, nothing without", () => {
		const lines = renderIntel({
			fileMap: ["- src/work.ts:2 — matched: composeBrief"],
			doneDigest: ["Done when gates pass green."],
		});
		expect(lines).toContain(
			"FILE MAP (pointer-grade, derived from the mission — verify anchors before editing):",
		);
		expect(lines).toContain("  - src/work.ts:2 — matched: composeBrief");
		expect(lines).toContain(
			"DONE DEFINITION (digest — the lane's stop condition):",
		);

		const mapOnly = renderIntel({
			fileMap: ["- src/x.ts:1 — matched: foo"],
			doneDigest: [],
		});
		expect(mapOnly.join("\n")).not.toContain("DONE DEFINITION");
		expect(renderIntel(null)).toEqual([]);
		expect(renderIntel(undefined)).toEqual([]);
		expect(renderIntel({ fileMap: [], doneDigest: [] })).toEqual([]);
	});
});

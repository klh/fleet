// runtime-overlay-drift.test.ts — the W556 overlay contract, self-enforcing
// (W741): the runtime-home copies (~/.claude/local-llm/*.ts) of the
// router-shim import closure must stay in normalized agreement with the repo
// copies. The closure is computed exactly the way the installer computes it
// (beltBinClosure over the router-shim entry) — no second file list to
// drift. swarm.ts is deliberately OUT: the runtime swarm.ts is its own
// source of truth (W556; install refuses to clobber it). The drift class
// observed 2026-10-13 was doc-comments + formatting; normalization strips
// those so only SUBSTANTIVE divergence trips — a red here means the runtime
// face is running different logic than the repo claims, and the fix is the
// belt-bin-overlay.ts refresh verb (heals real modules for re-export shims),
// never to edit around it.
import { expect, setDefaultTimeout, test as baseTest } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	beltBinClosure,
	flatHomeSource,
	normalizeSource,
} from "../../suspenders/scripts/belt-bin-overlay.ts";

const ROOT = join(import.meta.dir, "../bin");
const RUNTIME = join(homedir(), ".claude", "local-llm");

setDefaultTimeout(15_000);

// W1135.1.7: a missing runtime home SKIPS with a visible reason instead of
// silently self-passing on a non-operator machine. Bound through a `test`
// alias so the suite still declares the same named test everywhere
// (W833 claim-check diffs test names against the claim baseline).
const isOperatorMachine = existsSync(RUNTIME);
const test = baseTest.skipIf(!isOperatorMachine);

test("runtime-home overlays agree with the repo copies (normalized)", async () => {
	const entry = join(ROOT, "router-shim.ts");
	const closure = await beltBinClosure(entry, ROOT);
	expect(closure.length).toBeGreaterThan(5);
	const drifted: string[] = [];
	for (const rel of ["router-shim.ts", ...closure]) {
		const home = join(RUNTIME, rel.split("/").slice(-1)[0] ?? rel);
		if (!existsSync(home)) {
			drifted.push(`${rel}: MISSING in runtime home`);
			continue;
		}
		const a = normalizeSource(
			readFileSync(await flatHomeSource(ROOT, rel), "utf8"),
		);
		const b = normalizeSource(readFileSync(home, "utf8"));
		if (a === b) continue;
		const la = a.split("\n");
		const lb = b.split("\n");
		let first = 0;
		while (first < la.length && first < lb.length && la[first] === lb[first])
			first += 1;
		drifted.push(
			`${rel}: diverges at repo:${String(first + 1)} ` +
				`(repo: ${JSON.stringify(la[first] ?? "<eof>").slice(0, 90)} vs ` +
				`home: ${JSON.stringify(lb[first] ?? "<eof>").slice(0, 90)})`,
		);
	}
	expect(drifted).toEqual([]);
});

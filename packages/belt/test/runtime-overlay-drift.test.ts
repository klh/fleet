// runtime-overlay-drift.test.ts — the W556 overlay contract, self-enforcing
// (W741, W1250): the runtime-home copies (~/.claude/local-llm/*.ts) of the
// belt closures must stay in normalized agreement with the PINNED ARTIFACT
// FACE — the real module over a re-export shim with cross-package specifiers
// rewritten to flat siblings, i.e. exactly the bytes the refresh verb
// materializes (pinnedFaceText). Never a second mutable source of truth: a
// red here means the runtime face is running different logic than the repo
// claims, and the fix is the belt-bin-overlay.ts refresh verb (verified
// reconciliation), never to edit around it. Both install entries ride the
// probe: the router (router-shim) AND the supervisor (swarm — the spawner/
// litellm-target twins' only importers). swarm.ts itself stays OUT: the
// runtime swarm.ts is its own source of truth (W556; install refuses to
// clobber it).
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	beltBinClosure,
	flatExternals,
	flatHomeSource,
	normalizeSource,
	pinnedFaceText,
} from "@klh/suspenders/scripts/belt-bin-overlay.ts";

const ROOT = join(import.meta.dir, "../bin");
const RUNTIME = join(homedir(), ".claude", "local-llm");

setDefaultTimeout(15_000);

test("runtime-home overlays agree with the pinned artifact face (normalized)", async () => {
	if (!existsSync(RUNTIME)) return; // not an operator machine
	// the two install entries (seedLocalLlm refreshes swarm first, then
	// router-shim — last writer owns a shared member); swarm's closure is
	// the one that carries the spawner/litellm-target twins
	const faces = new Map<string, string>();
	for (const entry of ["swarm.ts", "router-shim.ts"]) {
		const externals = await flatExternals(join(ROOT, entry), ROOT);
		const rels = new Set<string>([
			entry,
			...(await beltBinClosure(join(ROOT, entry), ROOT)),
		]);
		expect(rels.size).toBeGreaterThan(5);
		for (const rel of rels) {
			const source = await flatHomeSource(ROOT, rel);
			faces.set(
				rel,
				normalizeSource(await pinnedFaceText(source, externals, ROOT)),
			);
		}
	}
	expect(faces.size).toBeGreaterThan(5);
	const drifted: string[] = [];
	for (const [rel, want] of faces) {
		const home = join(RUNTIME, rel.split("/").slice(-1)[0] ?? rel);
		if (!existsSync(home)) {
			drifted.push(`${rel}: MISSING in runtime home`);
			continue;
		}
		const have = normalizeSource(readFileSync(home, "utf8"));
		if (want === have) continue;
		const la = want.split("\n");
		const lb = have.split("\n");
		let first = 0;
		while (first < la.length && first < lb.length && la[first] === lb[first])
			first += 1;
		drifted.push(
			`${rel}: diverges at pinned face:${String(first + 1)} ` +
				`(face: ${JSON.stringify(la[first] ?? "<eof>").slice(0, 90)} vs ` +
				`home: ${JSON.stringify(lb[first] ?? "<eof>").slice(0, 90)})`,
		);
	}
	expect(drifted).toEqual([]);
});

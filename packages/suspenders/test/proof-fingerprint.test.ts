// proof-fingerprint.test.ts — W2181: the verify.py fingerprint port. Unit
// face for workspaceFingerprint (determinism, mid-run write, deletion,
// unreadable → null) and fingerprintVerdict (unknown semantics: either side
// null = unknown; mismatch = changed; equal = unchanged).
import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fingerprintVerdict,
	workspaceFingerprint,
} from "../hooks/lib/gates/proof-fingerprint.ts";

const roots: string[] = [];
const tree = (): string => {
	const root = mkdtempSync(join(tmpdir(), "w2181-fp-"));
	roots.push(root);
	return root;
};

afterAll(() => {
	// bun rmSync(force) can silently leave the fixture's .git — bounded 2nd pass
	for (const r of roots) {
		for (const inner of ["locked", "sub"])
			try {
				chmodSync(join(r, inner), 0o755);
			} catch {
				// the tree never created this dir
			}
		rmSync(r, { recursive: true, force: true });
		rmSync(r, { recursive: true, force: true });
	}
});

test("unchanged tree: identical hashes across two fingerprints", () => {
	const root = tree();
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub/b.ts"), "export const b = 2;\n");
	const before = workspaceFingerprint(root);
	const after = workspaceFingerprint(root);
	expect(before).toBeString();
	expect(before).toBe(after);
});

test("mid-run write flips the verdict to changed (never a pass)", () => {
	const root = tree();
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	const before = workspaceFingerprint(root);
	// the verification run writes into the workspace mid-run
	writeFileSync(join(root, "planted.txt"), "mid-run write\n");
	const after = workspaceFingerprint(root);
	expect(fingerprintVerdict(before, after)).toBe("changed");
	// a deletion mid-run changes the fingerprint too
	const before2 = workspaceFingerprint(root);
	rmSync(join(root, "planted.txt"), { force: true });
	expect(fingerprintVerdict(before2, workspaceFingerprint(root))).toBe(
		"changed",
	);
});

test("explicit path set: content change flips, sort order is stable", () => {
	const root = tree();
	writeFileSync(join(root, "a.ts"), "one\n");
	writeFileSync(join(root, "b.ts"), "two\n");
	const paths = ["b.ts", "a.ts"];
	const h1 = workspaceFingerprint(root, paths);
	expect(workspaceFingerprint(root, ["a.ts", "b.ts"])).toBe(h1);
	writeFileSync(join(root, "b.ts"), "two!\n");
	expect(workspaceFingerprint(root, paths)).not.toBe(h1);
});

test("unreadable tree fingerprints null — callers bank unknown, never pass", () => {
	const root = tree();
	writeFileSync(join(root, "a.ts"), "one\n");
	mkdirSync(join(root, "locked"));
	writeFileSync(join(root, "locked/m.ts"), "one\n");
	chmodSync(join(root, "locked"), 0o000);
	expect(workspaceFingerprint(root)).toBeNull();
	expect(workspaceFingerprint(root, ["locked/m.ts"])).toBeNull();
	expect(workspaceFingerprint(root, ["absent.ts"])).toBeNull();
});

test("fingerprintVerdict: either side null is unknown; mismatch is changed", () => {
	expect(fingerprintVerdict(null, "abc")).toBe("unknown");
	expect(fingerprintVerdict("abc", null)).toBe("unknown");
	expect(fingerprintVerdict(null, null)).toBe("unknown");
	expect(fingerprintVerdict("abc", "abc")).toBe("unchanged");
	expect(fingerprintVerdict("abc", "abd")).toBe("changed");
});

test("skipped entries: .git, node_modules symlink, .fleet never fold in", () => {
	const root = tree();
	writeFileSync(join(root, "a.ts"), "one\n");
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git/HEAD"), "ref: x\n");
	mkdirSync(join(root, ".fleet"));
	writeFileSync(join(root, ".fleet/lanes.json"), "[]\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules/x"), "dep\n");
	const h = workspaceFingerprint(root);
	// mutating the skipped entries leaves the fingerprint unchanged
	writeFileSync(join(root, ".git/HEAD"), "ref: y\n");
	writeFileSync(join(root, "node_modules/x"), "dep!\n");
	expect(workspaceFingerprint(root)).toBe(h);
});

// merge-guard-relocation.ts — W1216.2: bounded test-relocation proof for the
// merge guard. A candidate tripping the erosion ratio on a TEST file is
// allowed ONLY if its test-name multiset delta nets to zero across every
// changed .test file: moves between files cancel; deletions, renames and
// unrelated new tests leave residue and fail closed.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i;
const TEST_NAME = new RegExp(
	String.raw`\b(?:test|it)\b(?:\.[a-z]+)*\s*\(\s*(["` +
		"`" +
		String.raw`])((?:\\.|(?!\1).)*)\1`,
	"gs",
);
const MAX_TEST_FILES = 400;

function gitOut(cwd: string, args: string[]): { code: number; out: string } {
	const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode ?? 1, out: p.stdout.toString() };
}

function testNames(src: string): Map<string, number> {
	const names = new Map<string, number>();
	for (const m of src.matchAll(TEST_NAME)) {
		const name = m[2] ?? "";
		names.set(name, (names.get(name) ?? 0) + 1);
	}
	return names;
}

/** Enumerate the candidate's changed .test files and diff their test-name
 * multisets. Returns balanced=false with a fail-closed why on any residue. */
export function testRelocationDelta(
	repo: string,
	before: string,
	tree: string,
): { balanced: boolean; why: string } {
	const removed = new Map<string, number>();
	const added = new Map<string, number>();
	let scanned = 0;
	for (const filter of ["--diff-filter=ACMR", "--diff-filter=D"]) {
		const diff = gitOut(repo, [
			"git",
			"diff",
			"--name-only",
			"-z",
			filter,
			before,
			tree,
		]);
		if (diff.code !== 0)
			return { balanced: false, why: "cannot enumerate changed test files" };
		for (const p of diff.out.split("\0").filter((x) => TEST_FILE.test(x))) {
			if (++scanned > MAX_TEST_FILES)
				return {
					balanced: false,
					why: "cannot prove relocation within 400 changed test files",
				};
			const oldSrc = gitOut(repo, ["git", "show", `${before}:${p}`]);
			const newSrc = gitOut(repo, ["git", "show", `${tree}:${p}`]);
			const oldNames = oldSrc.code === 0 ? testNames(oldSrc.out) : new Map();
			const newNames = newSrc.code === 0 ? testNames(newSrc.out) : new Map();
			for (const [name, n] of oldNames) {
				const delta = n - (newNames.get(name) ?? 0);
				if (delta > 0) removed.set(name, (removed.get(name) ?? 0) + delta);
			}
			for (const [name, n] of newNames) {
				const delta = n - (oldNames.get(name) ?? 0);
				if (delta > 0) added.set(name, (added.get(name) ?? 0) + delta);
			}
		}
	}
	const offenders: string[] = [];
	for (const [name, n] of removed)
		if ((added.get(name) ?? 0) < n)
			offenders.push(
				`not relocated: ${JSON.stringify(name)} x${String(n - (added.get(name) ?? 0))}`,
			);
	for (const [name, n] of added)
		if ((removed.get(name) ?? 0) < n)
			offenders.push(
				`unrelated addition: ${JSON.stringify(name)} x${String(n - (removed.get(name) ?? 0))}`,
			);
	if (offenders.length > 0)
		return { balanced: false, why: offenders.slice(0, 5).join("; ") };
	return { balanced: true, why: "" };
}

export { TEST_FILE };

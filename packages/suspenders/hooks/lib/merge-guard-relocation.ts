// merge-guard-relocation.ts — W1216.2.1: bounded STRUCTURAL test-relocation
// proof for the merge guard. A candidate tripping the erosion ratio on a TEST
// file is allowed ONLY if every removed (name, body) pair reappears verbatim
// in the candidate: bodies are sliced string/comment-aware from each test
// call, normalized for indentation only, and compared as multisets. Name-only
// matches are worthless — a test kept with an emptied or weakened callback
// leaves residue and the candidate fails closed. Shared helper evidence
// (test/helpers, fixtures) must persist unmodified: a weakened helper can
// erode assertions even when every test body hashes equal. Anything the
// scanner cannot prove — dynamic names, unterminated lexemes, unbalanced
// calls, oversized input — is unprovable and fails closed.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i;
const HELPER_FILE = /\/(?:helpers|fixtures|__fixtures__)\/.+$/;
const CALL_HEAD = /^(?:test|it)(?:\.[a-z]+)*\s*\(/;
const MAX_TEST_FILES = 400;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

type Evidence = { tests: number; expects: number };

function gitOut(cwd: string, args: string[]): { code: number; out: string } {
	const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode ?? 1, out: p.stdout.toString() };
}

/** Index after a lexeme's terminator, or -1 when unterminated. Plain and
 * template literals: templates honor ${ ... } nesting (recursively). */
function skipString(src: string, start: number): number {
	const q = src[start];
	let i = start + 1;
	if (q !== "`") {
		while (i < src.length) {
			const c = src[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === q) return i + 1;
			if (c === "\n") return -1; // ' and " cannot span lines
			i++;
		}
		return -1;
	}
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "`") return i + 1;
		if (c === "$" && src[i + 1] === "{") {
			// ${ ... } — code again: strings/comments/nested templates resume
			let depth = 1;
			i += 2;
			while (i < src.length && depth > 0) {
				const d = src[i];
				if (d === "\\") {
					i += 2;
					continue;
				}
				if (d === '"' || d === "'" || d === "`") {
					const e = skipString(src, i);
					if (e < 0) return -1;
					i = e;
					continue;
				}
				if (d === "/" && src[i + 1] === "/") {
					const e = src.indexOf("\n", i);
					i = e < 0 ? src.length : e;
					continue;
				}
				if (d === "/" && src[i + 1] === "*") {
					const e = src.indexOf("*/", i + 2);
					if (e < 0) return -1;
					i = e + 2;
					continue;
				}
				if (d === "{") depth++;
				if (d === "}") depth--;
				i++;
			}
			if (depth !== 0) return -1;
			continue;
		}
		i++;
	}
	return -1;
}

/** Slice each test call: name literal + normalized callback source. Returns
 * unprovable=true when any test( / it( call cannot be structurally proven —
 * non-literal name, unbalanced call, unterminated lexeme or the whole-file
 * unterminated lexeme cascades that would hide real test calls. */
export function scanTestStructure(src: string): {
	nodes: { name: string; body: string }[];
	unprovable: boolean;
} {
	const nodes: { name: string; body: string }[] = [];
	const mark = () => {
		nodes.length = 0;
		return { nodes, unprovable: true };
	};
	const n = src.length;
	let i = 0;
	while (i < n) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			const e = skipString(src, i);
			if (e < 0) return mark();
			i = e;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const e = src.indexOf("\n", i);
			i = e < 0 ? n : e;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			if (e < 0) return mark();
			i = e + 2;
			continue;
		}
		if (
			(c === "t" || c === "i") &&
			(i === 0 || !/[\w.]/.test(src[i - 1])) &&
			CALL_HEAD.test(src.slice(i, i + 64))
		) {
			const parsed = parseCall(src, i);
			if (parsed === null) return mark();
			nodes.push(parsed.node);
			i = parsed.end;
			continue;
		}
		i++;
	}
	return { nodes, unprovable: false };
}

/** Parse one test( / it( call at `head`. The name must be a string or
 * template literal; the body is the raw source after the name's comma up to
 * the call's closing paren (or empty for callback-less forms like
 * test.todo). end = index after the closing paren. */
function parseCall(
	src: string,
	head: number,
): { node: { name: string; body: string }; end: number } | null {
	let i = head;
	while (src[i] !== "(") i++;
	i++;
	while (
		src[i] === " " ||
		src[i] === "\t" ||
		src[i] === "\n" ||
		src[i] === "\r"
	)
		i++;
	const q = src[i];
	if (q !== '"' && q !== "'" && q !== "`") return null;
	const nameEnd = skipString(src, i);
	if (nameEnd < 0) return null;
	const name = src.slice(i + 1, nameEnd - 1);
	i = nameEnd;
	while (
		src[i] === " " ||
		src[i] === "\t" ||
		src[i] === "\n" ||
		src[i] === "\r"
	)
		i++;
	let bodyStart: number;
	let bodyEnd: number;
	if (src[i] === ")") {
		bodyStart = i;
		bodyEnd = i;
		i++;
	} else if (src[i] === ",") {
		i++;
		bodyStart = i;
		// paren-match the whole call, string/comment/template aware
		let depth = 1;
		while (i < src.length && depth > 0) {
			const c = src[i];
			if (c === '"' || c === "'" || c === "`") {
				const e = skipString(src, i);
				if (e < 0) return null;
				i = e;
				continue;
			}
			if (c === "/" && src[i + 1] === "/") {
				const e = src.indexOf("\n", i);
				i = e < 0 ? src.length : e;
				continue;
			}
			if (c === "/" && src[i + 1] === "*") {
				const e = src.indexOf("*/", i + 2);
				if (e < 0) return null;
				i = e + 2;
				continue;
			}
			if (c === "(") depth++;
			if (c === ")") depth--;
			i++;
		}
		if (depth !== 0) return null;
		bodyEnd = i - 1;
	} else {
		return null;
	}
	const body = src
		.slice(bodyStart, bodyEnd)
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/^[ \t]+/, ""))
		.filter((line) => line.trim() !== "")
		.join("\n");
	return { node: { name, body }, end: i };
}

/** Test + assertion evidence for one source file: extracted test count and
 * the number of expect( calls inside the extracted bodies. */
export function testEvidence(src: string): Evidence {
	const { nodes, unprovable } = scanTestStructure(src);
	if (unprovable) return { tests: -1, expects: -1 };
	let expects = 0;
	for (const node of nodes)
		for (const _unused of node.body.matchAll(/\bexpect\s*\(/g)) expects++;
	return { tests: nodes.length, expects };
}

function blobSize(repo: string, ref: string, path: string): number {
	const s = gitOut(repo, ["git", "cat-file", "-s", `${ref}:${path}`]);
	return s.code === 0 ? Number(s.out.trim()) : -1;
}

function blobText(repo: string, ref: string, path: string): string | null {
	if (blobSize(repo, ref, path) > MAX_SOURCE_BYTES) return null;
	const b = gitOut(repo, ["git", "show", `${ref}:${path}`]);
	return b.code === 0 ? b.out : null;
}

function addAll(
	into: Map<string, number>,
	nodes: { name: string; body: string }[],
): void {
	for (const node of nodes) {
		const key = `${node.name}\u0000${node.body}`;
		into.set(key, (into.get(key) ?? 0) + 1);
	}
}

/** Enumerate the candidate's changed test + helper files and prove the
 * structural relocation: every removed (name, body) pair must reappear
 * verbatim elsewhere in the candidate, and existing helper evidence must
 * persist unmodified. Returns balanced=false with a fail-closed why on any
 * residue or anything unprovable. */
export function testRelocationDelta(
	repo: string,
	before: string,
	tree: string,
): { balanced: boolean; why: string; evidence?: string } {
	const diff = gitOut(repo, [
		"git",
		"diff",
		"--name-status",
		"-z",
		"-M",
		before,
		tree,
	]);
	if (diff.code !== 0)
		return { balanced: false, why: "cannot enumerate changed test files" };
	const parts = diff.out.split("\0");
	const oldMultiset = new Map<string, number>();
	const newMultiset = new Map<string, number>();
	let scanned = 0;
	let totalBytes = 0;
	let p = 0;
	while (p < parts.length) {
		const status = parts[p++];
		if (status === "") continue;
		let path = parts[p++];
		// R/C rows carry <status><score>\0<src>\0<dst>
		const score = status.slice(1);
		if (score !== "" && !/^\d+$/.test(score)) {
			// not a rename row after all: treat as path-less stray and stop
			return { balanced: false, why: "cannot parse candidate name-status" };
		}
		let srcPath = path;
		if (status.startsWith("R") || status.startsWith("C")) {
			srcPath = parts[p++]; // not used beyond parsing; dst is authoritative
			path = parts[p++];
		}
		if (TEST_FILE.test(path)) {
			if (++scanned > MAX_TEST_FILES)
				return {
					bedrock: undefined,
					balanced: false,
					why: "cannot prove relocation within 400 changed test files",
				} as never;
			const oldSrc = blobText(repo, before, path);
			const newSrc = blobText(repo, tree, path);
			totalBytes += (oldSrc?.length ?? 0) + (newSrc?.length ?? 0);
			if (totalBytes > MAX_TOTAL_BYTES)
				return {
					balanced: false,
					why: "cannot prove relocation within a 16MB candidate delta",
				};
			const oldScan = oldSrc === null ? null : scanTestStructure(oldSrc);
			const newScan = newSrc === null ? null : scanTestStructure(newSrc);
			if (oldSrc !== null && oldScan.unprovable)
				return {
					balanced: false,
					why: `unprovable test structure in ${JSON.stringify(path)}`,
				};
			if (newSrc !== null && newScan.unprovable)
				return {
					balanced: false,
					why: `unprovable test structure in ${JSON.stringify(path)}`,
				};
			// A deleted (or oversized/unreadable) test file's old tests are
			// removals; its new side contributes nothing.
			if (oldSrc !== null) addAll(oldMultiset, oldScan.nodes);
			if (newSrc !== null) addAll(newMultiset, newScan.nodes);
		} else if (HELPER_FILE.test(path)) {
			if (status.startsWith("M") || status.startsWith("D"))
				return {
					balanced: false,
					why: `helper evidence eroded: ${JSON.stringify(path)} ${status.startsWith("M") ? "modified" : "deleted"} — relocation cannot vouch for weakened helpers`,
				};
			if (status.startsWith("R") && Number(score) < 100)
				return {
					balanced: false,
					why: `helper evidence eroded: ${JSON.stringify(srcPath)} renamed with ${score}% similarity`,
				};
		}
	}
	const offenders: string[] = [];
	for (const [key, n] of oldMultiset) {
		const kept = Math.min(n, newMultiset.get(key) ?? 0);
		if (n - kept > 0)
			offenders.push(
				`not relocated verbatim: ${JSON.stringify(key.split("\u0000")[0])} x${String(n - kept)}`,
			);
	}
	for (const [key, n] of newMultiset) {
		const kept = Math.min(n, oldMultiset.get(key) ?? 0);
		if (n - kept > 0)
			offenders.push(
				`unrelated addition: ${JSON.stringify(key.split("\u0000")[0])} x${String(n - kept)}`,
			);
	}
	if (offenders.length > 0)
		return { balanced: false, why: offenders.slice(0, 5).join("; ") };
	const tests = [...oldMultiset.values()].reduce((a, b) => a + b, 0);
	const evidence =
		scanned > 0
			? `relocation proven: ${String(tests)} test bodies preserved verbatim across ${String(scanned)} changed test files`
			: "";
	return { balanced: true, why: "", evidence };
}

export { HELPER_FILE, TEST_FILE };

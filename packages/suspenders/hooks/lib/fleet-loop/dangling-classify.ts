// dangling-classify.ts — W1302.8 (A22): classify path-like literals by SYNTAX
// and FILE CONTEXT before the dangling-path scan judges them. The old scan
// treated every quoted path-like string as a reference; the W1302.6 merge
// queued 62 repair items from review-test fixture names (`src.ts`, `docs.md`,
// `packages/app/value.ts`). A string is a reference only where its resolution
// base is known from syntax:
//   import    module specifier (Bun.Transpiler.scanImports, plus the
//             type-only imports the transpiler erases)
//   url       new URL(lit, import.meta.url) / import.meta.resolve(lit)
//   dir-join  join|resolve(import.meta.dir | __dirname, lit, ...)
//   config    path-valued JSON keys (main, bin, exports, extends, ...) and
//             quoted relative paths in markup/config text
// A plain string is data. Test files keep only their imports (every other
// string there names a synthetic tree); inert files — fixtures, skills,
// templates, vendored or generated output, prose — are never judged.

import {
	maskCode,
	STR,
	STR_ALL,
	type Masked,
	type Strings,
} from "./dangling-mask.ts";

export type RefKind = "import" | "url" | "dir-join" | "config";
export type Reference = { spec: string; kind: RefKind };
export type FileClass = "inert" | "test" | "live";

export const TEMPLATE_HOLE = /\$\{/;
const PATH_LIKE =
	/^(?:\.{1,2}\/|@klh\/)|\.(?:[cm]?[jt]sx?|json|jsonc|css|txt|md)$/i;
// quoted string bodies, longest-first alternation so adjacent quotes cannot
// shadow one another
const LITERAL = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

const INERT_FILE =
	/(?:^|\/)(?:fixtures?|__fixtures__|testdata|skills|skills-available|templates?|scaffolds?|docs|vendor|generated|node_modules|dist|build|packages\/decant)\/|\.(?:template|tmpl)\.[cm]?[jt]sx?$|\.(?:md|mdx|rst|txt|adoc)$/i;
const TEST_FILE =
	/(?:^|\/)(?:tests?|__tests__|e2e|bench|benchmarks?)\/|\.(?:test|spec|e2e|bench)\.[cm]?[jt]sx?$/i;
const CODE_FILE = /\.[cm]?[jt]sx?$/i;
const JSON_FILE = /\.jsonc?$/i;
const SHEBANG = /^#![^\n]*/;
// real ESM specifiers and runtime path strings are dot-prefixed; package
// imports ride @klh/ — bare names are npm packages or data
const REFERENCE_FORM = /^(?:\.{1,2}\/|@klh\/)/;
const CONCRETE = /^[^\s\\*?{}[\]]+$/;
// non-import references only count when they name code, config or markup
const ASSET_EXT =
	/\.(?:[cm]?[jt]sx?|jsonc?|css|html?|ya?ml|toml|plist|sh|txt|md)$/i;
const CONFIG_KEYS = new Set([
	"main",
	"module",
	"types",
	"typings",
	"bin",
	"exports",
	"imports",
	"extends",
	"entry",
	"entrypoints",
	"$schema",
]);
const IMPORT_KINDS = new Set([
	"import-statement",
	"dynamic-import",
	"require-call",
	"require-resolve",
]);
const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
	".tsx": "tsx",
	".jsx": "jsx",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
};

// call shapes run over masked code; biome formats multi-line calls with a
// trailing comma, so every shape tolerates one before its closing paren
const URL_FORM = new RegExp(
	String.raw`\bnew\s+URL\(\s*${STR}\s*,\s*import\.meta\.url\s*,?\s*\)`,
	"g",
);
const META_RESOLVE = new RegExp(
	String.raw`\bimport\.meta\.resolve\(\s*${STR}\s*,?\s*\)`,
	"g",
);
const DIR_JOIN = new RegExp(
	String.raw`\b(?:join|resolve)\(\s*(?:import\.meta\.(?:dir|dirname)|__dirname)((?:\s*,\s*${STR})+)\s*,?\s*\)`,
	"g",
);
const TYPE_IMPORT = new RegExp(
	String.raw`\b(?:import|export)\s+type\b[^;]*?\bfrom\s*${STR}`,
	"g",
);

export function classifyFile(file: string): FileClass {
	if (INERT_FILE.test(file)) return "inert";
	return TEST_FILE.test(file) ? "test" : "live";
}

/** Every path reference the file carries by syntax. Inert files carry none;
 * test files carry their imports only. */
export function referencesIn(file: string, body: string): Reference[] {
	const cls = classifyFile(file);
	if (cls === "inert") return [];
	if (CODE_FILE.test(file)) return codeReferences(file, body, cls === "live");
	if (cls !== "live") return [];
	return JSON_FILE.test(file) ? jsonReferences(body) : textReferences(body);
}

/** Every path-like string literal in the file body, in order. */
export function pathLiterals(body: string): string[] {
	const out: string[] = [];
	for (const m of body.matchAll(LITERAL)) {
		const spec = m[2];
		if (!spec || TEMPLATE_HOLE.test(spec) || !PATH_LIKE.test(spec)) continue;
		out.push(spec);
	}
	return out;
}

function keep(spec: string, kind: RefKind): boolean {
	if (!REFERENCE_FORM.test(spec) || !CONCRETE.test(spec)) return false;
	if (spec.includes("...")) return false; // doc ellipsis
	return kind === "import" || ASSET_EXT.test(spec);
}

function codeReferences(
	file: string,
	body: string,
	live: boolean,
): Reference[] {
	const src = body.replace(SHEBANG, "");
	const masked = maskCode(src);
	const refs = [
		...parsedImports(file, src),
		...collect(masked, TYPE_IMPORT, "import"),
	];
	if (!live) return refs;
	return [
		...refs,
		...collect(masked, URL_FORM, "url"),
		...collect(masked, META_RESOLVE, "url"),
		...dirJoins(masked),
	];
}

const transpilers = new Map<string, Bun.Transpiler>();

function transpilerFor(file: string): Bun.Transpiler {
	const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
	const loader = LOADERS[ext] ?? "ts";
	let t = transpilers.get(loader);
	if (!t) {
		t = new Bun.Transpiler({ loader });
		transpilers.set(loader, t);
	}
	return t;
}

function parsedImports(file: string, src: string): Reference[] {
	try {
		return transpilerFor(file)
			.scanImports(src)
			.filter((i) => IMPORT_KINDS.has(i.kind) && keep(i.path, "import"))
			.map((i) => ({ spec: i.path, kind: "import" as const }));
	} catch {
		return []; // unparseable source is not judged
	}
}

function literal(strings: Strings, idx: string | undefined) {
	const s = strings[Number(idx)];
	return typeof s === "string" ? s : null;
}

function collect(m: Masked, re: RegExp, kind: RefKind): Reference[] {
	const out: Reference[] = [];
	for (const hit of m.code.matchAll(re)) {
		const spec = literal(m.strings, hit[1]);
		if (spec !== null && keep(spec, kind)) out.push({ spec, kind });
	}
	return out;
}

// every argument must be a hole-free relative literal, else the join is not
// statically known
function joinedLiterals(tail: string, strings: Strings) {
	const parts: string[] = [];
	for (const p of tail.matchAll(STR_ALL)) {
		const s = literal(strings, p[1]);
		if (s === null || s.startsWith("/")) return null;
		parts.push(s);
	}
	return parts.join("/");
}

function dirJoins(m: Masked): Reference[] {
	const out: Reference[] = [];
	for (const hit of m.code.matchAll(DIR_JOIN)) {
		const joined = joinedLiterals(hit[1] ?? "", m.strings);
		if (joined === null) continue;
		const spec = /^\.{1,2}\//.test(joined) ? joined : `./${joined}`;
		if (keep(spec, "dir-join")) out.push({ spec, kind: "dir-join" });
	}
	return out;
}

function jsonReferences(body: string): Reference[] {
	const out: Reference[] = [];
	let doc: unknown;
	try {
		doc = JSON.parse(body);
	} catch {
		return out; // JSONC with comments is not judged
	}
	const walk = (node: unknown, inConfigKey: boolean): void => {
		if (typeof node === "string") {
			if (inConfigKey && keep(node, "config"))
				out.push({ spec: node, kind: "config" });
		} else if (Array.isArray(node)) {
			for (const v of node) walk(v, inConfigKey);
		} else if (node && typeof node === "object") {
			for (const [k, v] of Object.entries(node))
				walk(v, inConfigKey || CONFIG_KEYS.has(k));
		}
	};
	walk(doc, false);
	return out;
}

function textReferences(body: string): Reference[] {
	return pathLiterals(body)
		.filter((spec) => keep(spec, "config"))
		.map((spec) => ({ spec, kind: "config" as const }));
}

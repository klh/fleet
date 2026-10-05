// src/eval/tasks-code.ts — the code shape bucket: JavaScript output
// prediction over templated snippets. Keys are COMPUTED by mirrored TS ops;
// tests verify every snippet under node:vm, so a mirror drift fails loudly.
import { canon, metaOf, valueCheck } from "./graders.ts";
import { makeRng, type Rng } from "./rng.ts";
import type { Task } from "./types.ts";

const SYSTEM =
	"You are a JavaScript output predictor. Reply with the exact output value only — no explanation, no quotes. Arrays in JSON syntax.";

// ── families ──

/** map → filter → reduce chain over a small int array. */
function arrayChain(rng: Rng, i: number): Task {
	const arr = Array.from({ length: 4 }, () => 1 + rng.int(9));
	const k = 2 + rng.int(3);
	const t = k * 2;
	const key = arr
		.map((x) => x * k)
		.filter((x) => x > t)
		.reduce((s, x) => s + x, 0);
	const code = `const a=${JSON.stringify(arr)}; a.map(x=>x*${String(k)}).filter(x=>x>${String(t)}).reduce((s,x)=>s+x,0)`;
	return {
		id: `code-arr-${String(i)}`,
		shape: "code",
		system: SYSTEM,
		prompt: `What does this JavaScript expression evaluate to?\n\n${code}\n\nReply with the exact value only.`,
		key: String(key),
		check: valueCheck(key),
		meta: metaOf("array-chain", { code }),
	};
}

/** String method chain: slice + case/length/replace variants. */
function stringOps(rng: Rng, i: number): Task {
	const words = [
		"fleet",
		"router",
		"gateway",
		"budget",
		"ledger",
		"signal",
	] as const;
	const w = rng.pick(words);
	const variant = rng.int(3);
	let key: string | number;
	let expr: string;
	if (variant === 0) {
		const a = rng.int(w.length - 1);
		const b = a + 1 + rng.int(w.length - a);
		key = w.slice(a, b).toUpperCase();
		expr = `"${w}".slice(${String(a)},${String(b)}).toUpperCase()`;
	} else if (variant === 1) {
		key = w.length + 3;
		expr = `"${w}".length + 3`;
	} else {
		key = `${w}-${w.length}`;
		expr = `"${w}" + "-" + "${w}".length`;
	}
	return {
		id: `code-str-${String(i)}`,
		shape: "code",
		system: SYSTEM,
		prompt: `What does this JavaScript expression evaluate to?\n\n${expr}\n\nReply with the exact value only.`,
		key: canon(key),
		check: valueCheck(key),
		meta: metaOf("string-ops", { code: expr }),
	};
}

/** Ternary + comparison logic on two generated ints. */
function logicTernary(rng: Rng, i: number): Task {
	const x = 1 + rng.int(50);
	const y = 1 + rng.int(50);
	const variant = rng.int(3);
	let key: number;
	let expr: string;
	if (variant === 0) {
		key = x > y ? x - y : y - x;
		expr = `const x=${String(x)},y=${String(y)}; x > y ? x - y : y - x`;
	} else if (variant === 1) {
		key = x >= y ? x + y : x * y;
		expr = `const x=${String(x)},y=${String(y)}; x >= y ? x + y : x * y`;
	} else {
		key = x % 2 === 0 ? x + y : x - y + 100;
		expr = `const x=${String(x)},y=${String(y)}; x % 2 === 0 ? x + y : x - y + 100`;
	}
	return {
		id: `code-logic-${String(i)}`,
		shape: "code",
		system: SYSTEM,
		prompt: `What does this JavaScript snippet evaluate to?\n\n${expr}\n\nReply with the exact value only.`,
		key: String(key),
		check: valueCheck(key),
		meta: metaOf("logic-ternary", { code: expr }),
	};
}

/** Sort with a comparator, then index. */
function sortPick(rng: Rng, i: number): Task {
	const arr = Array.from({ length: 5 }, () => 1 + rng.int(99));
	const variant = rng.int(2);
	const sorted = [...arr].sort((x, y) => (variant === 0 ? x - y : y - x));
	const idx = 1 + rng.int(3);
	const key = sorted[idx] as number;
	const cmp = variant === 0 ? "x-y" : "y-x";
	const code = `const a=${JSON.stringify(arr)}; [...a].sort((x,y)=>${cmp})[${String(idx)}]`;
	return {
		id: `code-sort-${String(i)}`,
		shape: "code",
		system: SYSTEM,
		prompt: `What does this JavaScript expression evaluate to?\n\n${code}\n\nReply with the exact value only.`,
		key: String(key),
		check: valueCheck(key),
		meta: metaOf("sort-pick", { code }),
	};
}

/** Template literal assembly. */
function templateLit(rng: Rng, i: number): Task {
	const units = ["kg", "km", "ms", "usd"] as const;
	const unit = rng.pick(units);
	const n = 2 + rng.int(40);
	const f = 2 + rng.int(5);
	const key = `Total: ${String(n * f)} ${unit}`;
	const code = `\`Total: \${${String(n)} * ${String(f)}} ${unit}\``;
	return {
		id: `code-tmpl-${String(i)}`,
		shape: "code",
		system: SYSTEM,
		prompt: `What does this JavaScript template literal evaluate to?\n\n${code}\n\nReply with the exact value only.`,
		key,
		check: valueCheck(key),
		meta: metaOf("template-lit", { code }),
	};
}

const FAMILIES = [arrayChain, stringOps, logicTernary, sortPick, templateLit];

export function makeCodeTasks(n: number, seed: number): Task[] {
	const rng = makeRng(seed);
	return Array.from({ length: n }, (_, i) =>
		(FAMILIES[i % FAMILIES.length] as typeof arrayChain)(rng, i),
	);
}

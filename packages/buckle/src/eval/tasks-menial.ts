// src/eval/tasks-menial.ts — the menial shape bucket: extraction, shaping,
// counting over generated payloads. Keys computed from the generated data.
import { exactCheck, jsonCheck, metaOf, numCheck } from "./graders.ts";
import { makeRng, type Rng } from "./rng.ts";
import type { Task } from "./types.ts";

const SYSTEM =
	"You are a precise data assistant. Reply with only the answer — no explanation.";

const WORDS = [
	"alpha",
	"bravo",
	"delta",
	"kilo",
	"lima",
	"oscar",
	"romeo",
	"tango",
	"uniform",
	"victor",
] as const;
const FIELDS = [
	"sku",
	"region",
	"channel",
	"owner",
	"status",
	"tier",
	"zone",
] as const;
const VALUES = [
	"a7",
	"north",
	"web",
	"klaus",
	"open",
	"gold",
	"eu-1",
	"beta",
] as const;

// ── families ──

/** Flat JSON object → reply with one field's JSON value. */
function jsonExtract(rng: Rng, i: number): Task {
	const keys = [...FIELDS].slice(0, 4 + rng.int(3));
	const obj: Record<string, string | number | boolean> = {};
	for (const k of keys) {
		const kind = rng.int(3);
		obj[k] =
			kind === 0
				? rng.pick(VALUES)
				: kind === 1
					? 1 + rng.int(999)
					: rng.int(2) === 1;
	}
	const k = keys[rng.int(keys.length)] as string;
	const kv = obj[k] as string | number | boolean;
	return {
		id: `menial-json-${String(i)}`,
		shape: "menial",
		system: SYSTEM,
		prompt: `Given this JSON:\n${JSON.stringify(obj)}\n\nReply with only the value of the field "${k}", exactly as JSON (strings quoted).`,
		key: JSON.stringify(kv),
		check: jsonCheck(kv),
		meta: metaOf("json-extract"),
	};
}

/** CSV rows → sum the qty column. */
function csvSum(rng: Rng, i: number): Task {
	const rows = Array.from({ length: 5 + rng.int(4) }, () => ({
		item: rng.pick(WORDS),
		qty: 1 + rng.int(50),
	}));
	const key = rows.reduce((s, r) => s + r.qty, 0);
	const csv = [
		"item,qty",
		...rows.map((r) => `${r.item},${String(r.qty)}`),
	].join("\n");
	return {
		id: `menial-csv-${String(i)}`,
		shape: "menial",
		system: SYSTEM,
		prompt: `Given this CSV:\n${csv}\n\nReply with only the sum of the qty column.`,
		key: String(key),
		check: numCheck(key),
		meta: metaOf("csv-sum"),
	};
}

/** Dedupe + sort an int list (JSON array answer). */
function dedupeSort(rng: Rng, i: number): Task {
	const list = Array.from({ length: 8 }, () => 1 + rng.int(15));
	const key = [...new Set(list)].sort((a, b) => a - b);
	return {
		id: `menial-dedupe-${String(i)}`,
		shape: "menial",
		system: SYSTEM,
		prompt: `List: ${JSON.stringify(list)}\n\nReply with only the deduplicated list sorted ascending, as a JSON array.`,
		key: JSON.stringify(key),
		check: jsonCheck(key),
		meta: metaOf("dedupe-sort"),
	};
}

/** Count occurrences of a word in a list. */
function countInList(rng: Rng, i: number): Task {
	const list = Array.from({ length: 10 }, () => rng.pick(WORDS));
	const target = rng.pick(WORDS);
	const key = list.filter((w) => w === target).length;
	return {
		id: `menial-count-${String(i)}`,
		shape: "menial",
		system: SYSTEM,
		prompt: `List: ${list.join(", ")}\n\nHow many times does "${target}" appear? Reply with only the count.`,
		key: String(key),
		check: numCheck(key),
		meta: metaOf("count-in-list"),
	};
}

/** Template fill from a record. */
function templateFill(rng: Rng, i: number): Task {
	const id = `TKT-${String(100 + rng.int(900))}`;
	const area = rng.pick(FIELDS);
	const n = 1 + rng.int(99);
	const key = `${id} [${area}] open items: ${String(n)}`;
	return {
		id: `menial-fill-${String(i)}`,
		shape: "menial",
		system: SYSTEM,
		prompt: `Record: id=${id}, area=${area}, open_items=${String(n)}\n\nReply with only this line filled in: "<id> [<area>] open items: <n>"`,
		key,
		check: exactCheck(key),
		meta: metaOf("template-fill"),
	};
}

const FAMILIES = [jsonExtract, csvSum, dedupeSort, countInList, templateFill];

export function makeMenialTasks(n: number, seed: number): Task[] {
	const rng = makeRng(seed);
	return Array.from({ length: n }, (_, i) =>
		(FAMILIES[i % FAMILIES.length] as typeof jsonExtract)(rng, i),
	);
}

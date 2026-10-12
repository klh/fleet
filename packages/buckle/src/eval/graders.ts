// src/eval/graders.ts — answer normalizers + check builders shared by every
// task family. Prompts pin a strict answer format; graders apply light
// normalization (fences, quotes, punctuation, case, whitespace) and compare
// against the computed key.
import type { Task } from "./types.ts";

/** Strip markdown code fences (```lang ... ```). */
export function stripFences(s: string): string {
	let t = s.trim();
	if (t.startsWith("```")) {
		const lines = t.split("\n");
		lines.shift();
		if (lines.length > 0 && (lines.at(-1) ?? "").trim() === "```") lines.pop();
		t = lines.join("\n").trim();
	}
	return t;
}

/** Canonical loose normalization: fences off, lowercase, whitespace
 *  collapsed, trailing punctuation and surrounding quotes off. */
export function norm(s: string): string {
	return stripFences(s)
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.。!?…]+$/u, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
}

/** First number in a free-text answer (commas/spaces tolerated). */
export function numFrom(s: string): number | undefined {
	const m = stripFences(s)
		.replace(/[ ,]/g, "")
		.match(/-?\d+(?:\.\d+)?/u);
	if (!m) return undefined;
	return Number(m[0]);
}

export const exactCheck =
	(key: string) =>
	(answer: string): boolean =>
		norm(answer) === norm(key);

export const numCheck =
	(key: number) =>
	(answer: string): boolean =>
		numFrom(answer) === key;

export const containsCheck =
	(key: string) =>
	(answer: string): boolean =>
		norm(answer).includes(norm(key));

/** Deep equality for JSON answers (objects/arrays/scalars). */
export function jsonEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((x, i) => jsonEq(x, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const oa = a as Record<string, unknown>;
		const ob = b as Record<string, unknown>;
		const ka = Object.keys(oa).sort();
		const kb = Object.keys(ob).sort();
		if (ka.length !== kb.length) return false;
		return ka.every((k, i) => k === kb[i] && jsonEq(oa[k], ob[k]));
	}
	return false;
}

/** Grader for JSON-valued keys: parse the answer, deep-equal the key value. */
export const jsonCheck =
	(keyValue: unknown) =>
	(answer: string): boolean => {
		try {
			return jsonEq(JSON.parse(stripFences(answer)), keyValue);
		} catch {
			return false;
		}
	};

/** Canonical string for a JS value (arrays/objects via JSON). */
export const canon = (v: unknown): string =>
	typeof v === "string" ? v : JSON.stringify(v);

/** Grader for JS-value keys (code predict-output): JSON-equal when the key
 *  is structured, otherwise normalized equality. */
export const valueCheck =
	(keyValue: unknown) =>
	(answer: string): boolean => {
		const a = stripFences(answer).trim();
		if (typeof keyValue === "string") {
			return norm(a) === norm(keyValue);
		}
		if (a === norm(canon(keyValue))) return true;
		try {
			return jsonEq(JSON.parse(a), keyValue);
		} catch {
			return false;
		}
	};

/** Build the meta record every Task carries. */
export const metaOf = (
	family: string,
	extra: Record<string, string | number> = {},
): Record<string, string | number> => ({ family, ...extra });

export type { Task };

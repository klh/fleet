import { parseLawExpr } from "./policy/repo-laws.ts";
import { preferOverlayOf } from "./prefer-format.ts";

export type PreferKey = "tag" | "color" | "prefer" | "must";
export const PREFER_KEYS: readonly PreferKey[] = [
	"tag",
	"color",
	"prefer",
	"must",
];
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/i;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EXECUTOR_KEYS = new Set(["can", "hub", "hub-url"]);

const stripQuotes = (raw: string): string => {
	const open = raw.indexOf('"');
	if (open < 0) return raw.trim();
	const close = raw.indexOf('"', open + 1);
	return close < 0 ? raw.slice(open + 1).trim() : raw.slice(open + 1, close);
};

/** First valid definition per key wins; invalid legacy lines remain non-fatal. */
export function parsePreferFile(
	path: string,
	text: string,
): { values: Partial<Record<PreferKey, string>>; errors: string[] } {
	const values: Partial<Record<PreferKey, string>> = {};
	const errors: string[] = [];
	if (preferOverlayOf(path, text) !== null) return { values, errors };
	for (const [index, line] of text.split("\n").entries()) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		const key = (eq < 0 ? "" : t.slice(0, eq)).trim();
		const raw = eq < 0 ? "" : t.slice(eq + 1).trim();
		const at = `${path}:${String(index + 1)}`;
		if (EXECUTOR_KEYS.has(key)) continue;
		if (!PREFER_KEYS.includes(key as PreferKey)) {
			errors.push(
				`${at}: unknown key '${t.slice(0, 24)}' — expected tag, color, prefer, must`,
			);
			continue;
		}
		const k = key as PreferKey;
		if (
			(k === "prefer" || k === "must") &&
			!raw.startsWith('"') &&
			!/\s/.test(raw)
		)
			continue;
		const val = stripQuotes(raw);
		if (val === "") {
			errors.push(`${at}: ${k}= needs a "value"`);
			continue;
		}
		if (values[k] !== undefined) {
			errors.push(`${at}: ${k}= set more than once (first wins)`);
			continue;
		}
		if (k === "tag" && !TAG_RE.test(val)) {
			errors.push(
				`${at}: tag must be 1–32 chars [a-z0-9-], got '${val.slice(0, 24)}'`,
			);
			continue;
		}
		if (k === "color" && !COLOR_RE.test(val)) {
			errors.push(
				`${at}: color must be RGBHEX #RRGGBB, got '${val.slice(0, 24)}'`,
			);
			continue;
		}
		if (k === "prefer" || k === "must") {
			const v = parseLawExpr(val);
			if (!v.ok) {
				errors.push(`${at}: ${k}=: ${v.why}`);
				continue;
			}
		}
		values[k] = val;
	}
	return { values, errors };
}

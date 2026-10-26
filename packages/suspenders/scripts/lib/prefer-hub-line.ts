// scripts/lib/prefer-hub-line.ts — W1352: the installer and hub setup write
// (or offer) an UNQUOTED executor-chain `hub=<label>` line in the tree
// .prefer when a hub is configured or a quoted prefer names one. A quoted
// prefer=/must= is ROUTING-plane only (W519) — it never routes lanes to the
// hub's gateway, so setup must add the chain line itself or dispatch
// silently falls through to the default executor (the W1352 429/503 gap).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The repo tree a .prefer line routes: the enclosing git toplevel (the
 *  dispatch plane reads `<project>/.prefer`), null when git cannot tell. */
export const gitToplevel = (from: string): string | null => {
	const r = spawnSync("git", ["-C", from, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		timeout: 5000,
	});
	const out = (r.stdout ?? "").trim();
	return r.status === 0 && out ? out : null;
};

/** First quoted prefer=/must= value (comma-lists split) that names a known
 *  hub label, case-insensitive — the owner's routing hint naming its hub. */
export const hubLabelFromQuotedPrefer = (
	text: string,
	known: string[],
): string | null => {
	if (known.length === 0) return null;
	const lower = new Map(known.map((l) => [l.toLowerCase(), l]));
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (key !== "prefer" && key !== "must") continue;
		const value = line.slice(eq + 1).trim();
		// routing plane only: quoted or multi-token (W519 plane split)
		if (!value.startsWith('"') && !/\s/.test(value)) continue;
		const unquoted = value.startsWith('"')
			? value.slice(
					1,
					value.indexOf('"', 1) < 0 ? undefined : value.indexOf('"', 1),
				)
			: value;
		for (const token of unquoted.split(/[\s,]+/)) {
			const hit = lower.get(token.trim().toLowerCase());
			if (hit) return hit;
		}
	}
	return null;
};

/** Does the .prefer text already carry an unquoted executor-chain hub= line? */
export const hasPreferHubLine = (text: string): boolean =>
	text.split("\n").some((raw) => {
		const line = raw.trim();
		const eq = line.indexOf("=");
		if (eq <= 0) return false;
		if (line.slice(0, eq).trim() !== "hub") return false;
		const value = line.slice(eq + 1).trim();
		return value !== "" && !value.startsWith('"') && !/\s/.test(value);
	});

/** Which hub label setup should pin: a quoted prefer naming a known label
 *  wins (owner intent), else a SOLE configured hub (unambiguous). */
export const resolvePreferHubLabel = (
	preferText: string | null,
	knownLabels: string[],
): string | null => {
	const named = hubLabelFromQuotedPrefer(preferText ?? "", knownLabels);
	if (named) return named;
	return knownLabels.length === 1 ? (knownLabels[0] ?? null) : null;
};

export interface PreferHubLineResult {
	action: "present" | "written" | "created" | "no-prefer-file";
	path: string;
}

/** Idempotent write: append `hub=<label>` when no unquoted hub= line exists;
 *  never clobber, never touch an existing chain. Creates .prefer when absent. */
export const ensurePreferHubLine = (
	repo: string,
	label: string,
): PreferHubLineResult => {
	const path = join(repo, ".prefer");
	const text = existsSync(path) ? readFileSync(path, "utf8") : null;
	if (text !== null && hasPreferHubLine(text))
		return { action: "present", path };
	const line = `# W1352: unquoted executor-chain hub pin — quoted prefer= is routing-plane only\nhub=${label}\n`;
	if (text === null) {
		appendFileSync(path, `${line}`);
		return { action: "created", path };
	}
	appendFileSync(
		path,
		`${text.endsWith("\n") || text === "" ? "" : "\n"}${line}`,
	);
	return { action: "written", path };
};

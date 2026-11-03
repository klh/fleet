import { lstatSync, readFileSync } from "node:fs";
import {
	type PostureOverlay,
	parsePostureOverlay,
} from "./posture/posture.zod.ts";

/** null means legacy lines; invalid JSON objects never enter that plane. */
export function preferOverlayOf(
	path: string,
	text: string,
): PostureOverlay | null {
	return text.trimStart().startsWith("{")
		? parsePostureOverlay(text, path)
		: null;
}

/** Missing is optional; all other filesystem failures are configuration errors. */
export function readPreferText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				lstatSync(path);
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw new Error(`${path}: unreadable: ${String(statError)}`);
			}
		}
		throw new Error(`${path}: unreadable: ${String(error)}`);
	}
}

export interface PreferChainEntry {
	value: string;
	kind: "must" | "prefer" | "can";
	/** 1-based line, preserving the executor position law. */
	line: number;
}

export interface PreferExecutor {
	directives: PreferChainEntry[];
	hub: string | null;
	hubUrls: string[];
	can: { value: string; line: number } | null;
	/** W2570: `model=<id>` pins the MODEL the picked executor rides (an
	 * executor lane's slot.model is null by design — W422 — so a repo pin
	 * is the only per-repo way to say copilot+model on one lane). */
	model: string | null;
}

/** W2636: 1-based line of the LAST valid `model=` pin — the same last-wins
 * law parseExecutorPrefer applies to the value, kept beside the grammar it
 * mirrors so provenance never drifts from the parse. Null when absent. */
export function executorModelLine(text: string): number | null {
	let line: number | null = null;
	for (const [index, raw] of text.split("\n").entries()) {
		const eq = raw.indexOf("=");
		if (eq <= 0 || raw.slice(0, eq).trim() !== "model") continue;
		const value = raw.slice(eq + 1).trim();
		if (!value || value.startsWith('"') || /\s/.test(value)) continue;
		line = index + 1;
	}
	return line;
}

export function parseExecutorPrefer(text: string): PreferExecutor {
	const out: PreferExecutor = {
		directives: [],
		hub: null,
		hubUrls: [],
		can: null,
		model: null,
	};
	for (const [index, line] of text.split("\n").entries()) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (!value || value.startsWith('"') || /\s/.test(value)) continue;
		if (key === "must" || key === "prefer") {
			for (const target of value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean))
				out.directives.push({ value: target, kind: key, line: index + 1 });
		} else if (key === "can") out.can = { value, line: index + 1 };
		else if (key === "model") out.model = value;
		else if (key === "hub") out.hub = value;
		else if (key === "hub-url")
			out.hubUrls = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	}
	return out;
}

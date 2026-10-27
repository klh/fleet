import { lstatSync, readFileSync } from "node:fs";
import {
	parsePostureOverlay,
	type PostureOverlay,
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
}

export function parseExecutorPrefer(text: string): PreferExecutor {
	const out: PreferExecutor = {
		directives: [],
		hub: null,
		hubUrls: [],
		can: null,
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
		else if (key === "hub") out.hub = value;
		else if (key === "hub-url")
			out.hubUrls = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	}
	return out;
}

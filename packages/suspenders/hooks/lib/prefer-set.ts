// hooks/lib/prefer-set.ts — W1354: the supported write path for repo
// .prefer hub pins. The coordinator-edit-gate (W834) classifies .prefer as
// a structural repo write, so lanes/coordinators could not fix their own
// routing without an owner hand-edit; this lib + the `prefer` CLI
// (hooks/bin/prefer.ts) are the gate-exempt route for exactly that write.
// Scope: the chain keys the exec chain consumes — hub= and hub-url=
// (scripts/lib/exec-chain.ts). Quoted must=/prefer= stay SOFT hints (W1353
// WARN plane); hub= is what actually pins — hence the verb.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The keys `prefer set` writes — the exec-chain hub pinning pair. */
export const PREFER_SET_KEYS = ["hub", "hub-url"] as const;
export type PreferSetKey = (typeof PREFER_SET_KEYS)[number];

const HUB_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate one `prefer set` value; "" = valid (the key text is checked
 *  by the caller). Returns the error why, or null when ok. */
export function validatePreferSet(key: string, value: string): string | null {
	if (!(PREFER_SET_KEYS as readonly string[]).includes(key))
		return `unknown key '${key}' — prefer set writes ${PREFER_SET_KEYS.join(" | ")} only (a quoted prefer= is a soft hint; hub= is what pins)`;
	if (key === "hub") {
		if (!HUB_LABEL_RE.test(value))
			return `hub= needs a registry label token ([A-Za-z0-9._-]), got '${value.slice(0, 32)}'`;
		return null;
	}
	// hub-url: comma-separated http(s) candidate list
	const urls = value.split(",").map((u) => u.trim());
	if (!urls.length || urls.some((u) => !/^https?:\/\/\S+$/.test(u)))
		return `hub-url= needs comma-separated http(s) URLs, got '${value.slice(0, 64)}'`;
	return null;
}

/** The .prefer file `prefer set` targets from dir: the git toplevel's
 *  .prefer (the file the exec chain walks to), falling back to dir itself
 *  outside a repo. Pure path math — never creates anything. */
export function preferSetTarget(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	const top =
		r.exitCode === 0 ? r.stdout.toString().trim() : "";
	return join(top || dir, ".prefer");
}

export type PreferSetAction = "created" | "replaced" | "appended";

export interface PreferSetResult {
	file: string;
	action: PreferSetAction;
	line: string;
}

/** Set key=value in the .prefer at file: an existing (uncommented) key=
 *  line is replaced in place (position law — later lines win, so keeping
 *  the line where the owner put it preserves intent); otherwise the pair
 *  appends. Missing file is created with a one-line provenance header. */
export function setPreferValue(
	file: string,
	key: string,
	value: string,
): PreferSetResult {
	const line = `${key}=${value}`;
	const existed = existsSync(file);
	const lines = existed
		? readFileSync(file, "utf8").split("\n")
		: ["# .prefer — written by `prefer set` (W1354); see prefer.example"];
	const at = lines.findIndex((l) => {
		const t = l.trim();
		return !t.startsWith("#") && t.startsWith(`${key}=`);
	});
	let action: PreferSetAction;
	if (at >= 0) {
		lines[at] = line;
		action = "replaced";
	} else {
		while (lines.length && lines.at(-1) === "") lines.pop();
		lines.push(line);
		action = existed ? "appended" : "created";
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	return { file, action, line };
}

/** Read back the current chain pin (first uncommented hit per key). */
export function readPreferSet(
	file: string,
): Partial<Record<PreferSetKey, { value: string; line: number }>> {
	const out: Partial<Record<PreferSetKey, { value: string; line: number }>> =
		{};
	if (!existsSync(file)) return out;
	const lines = readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = (lines[i] ?? "").trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq < 0) continue;
		const key = t.slice(0, eq);
		if (!(PREFER_SET_KEYS as readonly string[]).includes(key)) continue;
		if (out[key as PreferSetKey]) continue;
		out[key as PreferSetKey] = { value: t.slice(eq + 1), line: i + 1 };
	}
	return out;
}

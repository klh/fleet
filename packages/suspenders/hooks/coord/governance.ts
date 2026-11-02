// hooks/coord/governance.ts — the fleet's governance mode (W422.17, owner
// ruling 2026-10-06): strict | solo, stored as the `fleet.governance` coord
// fact, readable and settable here. strict is the default (fact absent =
// strict) and refuses lanes that cannot ride the buckle front; solo relents
// to the belt-direct fallback. dispatch-next reads the same fact.
import { arg, db, die } from "./shared.ts";
import { z } from "zod";
import { verbContract, wantsJson } from "./json-out.ts";

export const GOVERNANCE_KEY = "fleet.governance";
const MODES = new Set(["strict", "solo"]);

// W2569: both faces render FROM one JSON contract — tty and --json agree.
const contract = verbContract({
	mode: z.enum(["strict", "solo"]),
	default: z.boolean(),
	source: z.string().nullable(),
});

export async function cmdGovernance(rest: string[]): Promise<void> {
	// positional mode: first non-flag token (--json rides rest too)
	const mode = rest.find((t) => !t.startsWith("--"));
	// read: one line — the stored mode, or `strict (default)` when unset
	if (mode === undefined) {
		const r = db
			.query("SELECT value, source FROM facts WHERE key = ?")
			.get(GOVERNANCE_KEY) as {
			value: string | null;
			source: string | null;
		} | null;
		const stored =
			r?.value === "strict" || r?.value === "solo" ? r.value : null;
		const payload = {
			schema_version: 1 as const,
			verb: "governance",
			mode: stored ?? "strict",
			default: stored === null,
			source: stored ? (r?.source ?? null) : null,
		};
		if (wantsJson(rest)) contract.emit(payload);
		else console.log(`${payload.mode}${payload.default ? " (default)" : ""}`);
		return;
	}
	if (!MODES.has(mode))
		die("usage: governance | governance strict|solo [--source s] [--json]");
	const src = arg("--source") ?? "owner";
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(GOVERNANCE_KEY, mode, src, Date.now());
	const payload = {
		schema_version: 1 as const,
		verb: "governance",
		mode: mode as "strict" | "solo",
		default: false,
		source: src,
	};
	if (wantsJson(rest)) contract.emit(payload);
	else console.log(`fleet.governance = ${payload.mode}`);
}

// hooks/coord/governance.ts — the fleet's governance mode (W422.17, owner
// ruling 2026-10-06): strict | solo, stored as the `fleet.governance` coord
// fact, readable and settable here. strict is the default (fact absent =
// strict) and refuses lanes that cannot ride the buckle front; solo relents
// to the belt-direct fallback. dispatch-next reads the same fact.
import { arg, db, die } from "./shared.ts";

export const GOVERNANCE_KEY = "fleet.governance";
const MODES = new Set(["strict", "solo"]);

export async function cmdGovernance(rest: string[]): Promise<void> {
	const mode = rest[0];
	// read: one line — the stored mode, or `strict (default)` when unset
	if (mode === undefined) {
		const r = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(GOVERNANCE_KEY) as { value: string } | null;
		console.log(
			r?.value === "strict" || r?.value === "solo"
				? r.value
				: "strict (default)",
		);
		return;
	}
	if (!MODES.has(mode))
		die("usage: governance | governance strict|solo [--source s]");
	const src = arg("--source") ?? "owner";
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(GOVERNANCE_KEY, mode, src, Date.now());
	console.log(`fleet.governance = ${mode}`);
}

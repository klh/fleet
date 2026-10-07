// test/replica-worker.ts — W468 helper process: runs n budget checks
// against a shared DB file and prints the accept count as JSON. Spawned by
// gov-replica-budgets.test.ts to prove the authority is process-shared.
import { Database } from "bun:sqlite";
import { Budgets, type BudgetLimits } from "../src/gov/budgets.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";

const [dbPath, n, keyId, teamId, keyRpm, teamRpm] = process.argv.slice(
	2,
) as string[];
if (
	dbPath === undefined ||
	n === undefined ||
	keyId === undefined ||
	teamId === undefined ||
	keyRpm === undefined ||
	teamRpm === undefined
) {
	console.error(
		"usage: replica-worker.ts <db> <n> <keyId> <teamId> <keyRpm|null> <teamRpm|null>",
	);
	process.exit(2);
}

const limit = (s: string): number | null => (s === "null" ? null : Number(s));

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
applyGovernanceSchema(db);
const b = new Budgets(db);
const keyLimits: BudgetLimits = { rpm: limit(keyRpm), tpm: null };
const team = {
	id: teamId,
	limits: { rpm: limit(teamRpm), tpm: null } as BudgetLimits,
};
let ok = 0;
for (let i = 0; i < Number(n); i++)
	if (b.check(keyId, keyLimits, 0, team).ok) ok++;
console.log(JSON.stringify({ ok }));
db.close();

// CLI-neutral entry point; adapters supply a stable session ID and repo cwd.
import { openGovernorDb, projectIdentity } from "../lib/govdb.ts";
import { checkSessionPolicies } from "../lib/session-policy.ts";

const sid = process.argv[2];
const repo = process.argv[3] ?? process.cwd();
if (!sid || sid === "--help") {
	console.log("usage: bun session-policy.ts <session-id> [repo-root]");
	process.exit(sid === "--help" ? 0 : 2);
}
const db = openGovernorDb();
try {
	const notes = await checkSessionPolicies({
		db,
		sid,
		repo,
		project: projectIdentity(repo),
	});
	if (notes.length) console.log(notes.join("\n"));
} catch {
	console.log(
		"POLICY CHECK UNAVAILABLE: invalid runtime configuration; policy compliance is unknown.",
	);
} finally {
	db.close();
}

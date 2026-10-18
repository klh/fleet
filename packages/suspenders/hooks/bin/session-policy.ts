// CLI-neutral entry point; adapters supply a stable session ID and repo cwd.
// W820.2: argv rides verb-kit (W651) — embedded door, positional contract kept.
import { openGovernorDb, projectIdentity } from "../lib/govdb.ts";
import { checkSessionPolicies } from "../lib/session-policy.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "session-policy",
	usage: "usage: bun session-policy.ts <session-id> [repo-root]",
	minPos: 1,
});
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) {
	console.error(SPEC.usage);
	process.exit(2);
}
const sid = outcome.parsed.pos[0];
const repo = outcome.parsed.pos[1] ?? process.cwd();
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

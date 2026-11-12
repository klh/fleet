// CLI wrapper — see oracle-lib.ts for the judge core (kept outside the
// evaluated worktree).
import { judgeFixture } from "./oracle-lib.ts";

const root = process.argv[2] ?? "";
if (!process.argv[2])
	throw new Error("usage: bun oracle.ts <fixture-worktree>");
const result = await judgeFixture(root);
console.log(JSON.stringify(result, null, 2));
if (result.passed < result.total) process.exit(1);

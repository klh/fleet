// scripts/lanes.ts — print a repo's .fleet/lanes.json as a table (W301).
// Read-only lane view: pid liveness via the shared lib's alive(), agent
// names trimmed to 24 chars, dead-pid rows dagger-prefixed.
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb.ts";
import { alive, lanesFileFor, loadLanes } from "./lib/lane.ts";

const argv = process.argv.slice(2);
const flag = argv.indexOf("--repo");
// fleet dir lives at the MAIN checkout root (.fleet beside .git);
// projectIdentity() is the shared common-git-dir, so a worktree default
// resolves to its parent. Non-git projects use the dir itself.
const pi = projectIdentity();
const repo =
	flag >= 0 && argv[flag + 1]
		? argv[flag + 1]
		: pi.endsWith("/.git")
			? dirname(pi)
			: pi;
const fleet = `${repo}/.fleet`;

const file = lanesFileFor(fleet);
if (!existsSync(file)) {
	console.error(`no lanes file: ${file}`);
	process.exit(1);
}

const lanes = loadLanes(fleet);
const rows = lanes.map((l) => {
	const live = alive(l.pid);
	return {
		mark: live ? "" : "†",
		agent: (l.agent ?? "").slice(0, 24),
		sid: l.sid,
		item: l.item,
		branch: l.branch,
		wt: basename(l.worktree),
	};
});
const dead = rows.filter((r) => r.mark !== "").length;

const widest = (vals: string[]): number =>
	Math.max(1, ...vals.map((v) => v.length));
const wAgent = widest(rows.map((r) => r.agent));
const wSid = widest(rows.map((r) => r.sid));
const wItem = widest(rows.map((r) => r.item));
const wBranch = widest(rows.map((r) => r.branch));

const hdr =
	`  ${"AGENT".padEnd(wAgent)}  ${"SID".padEnd(wSid)}  ` +
	`${"ITEM".padEnd(wItem)}  ${"BRANCH".padEnd(wBranch)}  WORKTREE`;
console.log(hdr);
for (const r of rows) {
	console.log(
		`${r.mark.padEnd(1)} ${r.agent.padEnd(wAgent)}  ${r.sid.padEnd(wSid)}  ${r.item.padEnd(wItem)}  ${r.branch.padEnd(wBranch)}  ${r.wt}`,
	);
}
console.log(`${lanes.length} lanes, ${dead} dead`);

// review-incident.ts — W792: incident tasks for the review arena — real
// fleet bugs extracted from git history at design time. The diff under
// review is the reverse of the fix (bug reintroduction); ground truth is
// the documented defect, pinned by anchor. Design refuses loudly when a
// sha, path or anchor is missing — the seal stays honest.
import { lineOf, type Defect, type ReviewTask } from "./review-core.ts";

interface IncidentDef {
	id: string;
	sha: string; // fix commit; buggy state = its parent
	title: string;
	mission: string;
	paths: string[]; // repo-relative at the fix commit
	defects: {
		cls: string; // DefectClass, kept loose to avoid a circular import
		file: string;
		anchor: string; // unique substring in the buggy blob
		desc: string;
	}[];
}

const INCIDENTS: IncidentDef[] = [
	{
		id: "inc-w663",
		sha: "ca301352",
		title: "Board payload storm (W663)",
		mission:
			"Land this board payload change — /api/data latency must survive 445 registered lanes.",
		paths: [
			"packages/suspenders/hooks/board/lanes.ts",
			"packages/suspenders/hooks/board/data.ts",
		],
		defects: [
			{
				cls: "n-plus-one",
				file: "packages/suspenders/hooks/board/data.ts",
				anchor: "label(s.sid",
				desc: "per-sid label() store-RPC inside the payload walk",
			},
			{
				cls: "n-plus-one",
				file: "packages/suspenders/hooks/board/data.ts",
				anchor: "laneModelOf(s.sid",
				desc: "laneModelOf(s.sid) costs 3 store RPCs per sid inside the same walk",
			},
		],
	},

	{
		id: "inc-w250",
		sha: "95cbc90f",
		title: "Minter argv misparse (W250)",
		mission:
			"Land this approve-destructive CLI change — the command text after `--` must bind correctly.",
		paths: ["hooks/bin/approve-destructive.ts"],
		defects: [
			{
				cls: "argv-misparse",
				file: "hooks/bin/approve-destructive.ts",
				anchor: ".slice(sep + 1)",
				desc: "bun strips `--` — sep is -1 and slice(sep + 1) keeps the whole argv as the command text",
			},
		],
	},
	{
		id: "inc-w602",
		sha: "fd7025d",
		title: "Caddy loopback bind (W602)",
		mission:
			"Land this Caddy exposure change — every generated listener must load unprivileged on macOS.",
		paths: ["packages/local/bin/klh-local.ts"],
		defects: [
			{
				cls: "privileged-bind",
				file: "packages/local/bin/klh-local.ts",
				anchor: "bind 127.0.0.1 ::1",
				desc: "unprivileged listener bind of 127.0.0.1 on :443 — EACCES on macOS (W602)",
			},
		],
	},
];
export { INCIDENTS };

const git = (args: string[], cwd: string): string => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return p.stdout.toString();
};

/** Extract one incident task from git history. Throws with the sha in the
 *  message when a path or anchor is missing — design refuses, seal stays honest. */
export function incidentTask(def: IncidentDef, repo: string): ReviewTask {
	const parent = `${def.sha}^`;
	const diff = def.paths
		.map((p) => git(["diff", def.sha, parent, "--", p], repo))
		.filter(Boolean)
		.join("\n");
	if (!diff.trim())
		throw new Error(`incident def ${def.id}: empty diff for ${def.sha} (${def.paths.join(", ")})`);
	const defectFile = def.defects[0]?.file;
	const buggy = defectFile ? git(["show", `${parent}:${defectFile}`], repo) : "";
	const fixed = defectFile ? git(["show", `${def.sha}:${defectFile}`], repo) : "";
	return {
		id: def.id,
		src: "incident",
		title: def.title,
		mission: def.mission,
		diff,
		defects: incidentDefects(def, repo),
		files: defectFile
			? { buggy: { [defectFile]: buggy }, fixed: { [defectFile]: fixed } }
			: undefined,
	};
}

function incidentDefects(def: IncidentDef, repo: string): Defect[] {
	return def.defects.map((d, i) => {
		const blob = git(["show", `${def.sha}^:${d.file}`], repo);
		if (!blob.trim())
			throw new Error(`incident ${def.id}: no blob ${def.sha}^:${d.file}`);
		const line = lineOf(blob, d.anchor);
		if (!line)
			throw new Error(`incident ${def.id}: anchor "${d.anchor}" not in ${def.sha}^:${d.file}`);
		const defect: Defect = {
			id: `d${i + 1}`,
			cls: d.cls as DefectClassAlias,
			file: d.file,
			line,
			desc: d.desc,
		};
		return defect;
	});
}
type DefectClassAlias = import("./review-core.ts").DefectClass;

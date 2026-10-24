#!/usr/bin/env bun
// hooks/bin/checkpoint.ts — W253 agent CLI for the rolling compaction
// checkpoint (hooks/lib/checkpoint.ts). `set` rolls the file with fresh
// done/next bullets (plane header auto-derived: branch/head, owned work,
// capsule); `show` cats it; `path` prints where it lives.
import { existsSync, readFileSync } from "node:fs";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import {
	checkpointPath,
	rollCheckpoint,
	type CheckpointDb,
} from "../lib/checkpoint.ts";
import { defineVerb, runCli, type VerbSpec } from "../lib/verb-kit.ts";

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "set",
		usage:
			"usage: checkpoint set --as <sid> [--note s] [--next s] — roll the checkpoint with fresh done/next bullets",
		flags: ["--as", "--note", "--next"],
		reqFlags: ["--as"],
	}),
	defineVerb({
		name: "show",
		usage: "usage: checkpoint show --as <sid> — print the checkpoint body",
		flags: ["--as"],
		reqFlags: ["--as"],
	}),
	defineVerb({
		name: "path",
		usage: "usage: checkpoint path --as <sid> — print where it lives",
		flags: ["--as"],
		reqFlags: ["--as"],
	}),
];

await runCli({
	prog: "checkpoint",
	about: "checkpoint — the rolling compaction checkpoint (W253).",
	verbs: VERBS,
	dispatch: (name, p) => {
		const as = p.flag("--as") ?? "";
		const project = projectIdentity();
		if (name === "set") {
			const r = rollCheckpoint(
				openStore() as unknown as CheckpointDb,
				project,
				as,
				{
					cwd: process.cwd(),
					note: p.flag("--note"),
					next: p.flag("--next"),
				},
			);
			console.log(`checkpoint rolled (gen ${r.gen}): ${r.path}`);
		} else if (name === "show") {
			const path = checkpointPath(project, as);
			console.log(
				existsSync(path)
					? readFileSync(path, "utf8").trimEnd()
					: "(no checkpoint)",
			);
		} else {
			console.log(checkpointPath(project, as));
		}
	},
});

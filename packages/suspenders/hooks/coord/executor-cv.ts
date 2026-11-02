// hooks/coord/executor-cv.ts — W620: `coord executor-cv` — the executor
// trust tally surfaced as a verb. The fold prints (worst first); `--apply`
// banks it as facts executor.<host>.<model>.cv. Dispatch already folds +
// banks automatically on every spawn cycle; this verb is the operator's
// measure view (board/monitor read the same facts).

import { z } from "zod";
import {
	executorCv,
	writeExecutorCvFacts,
} from "../lib/executors/executor-cv.ts";
import { openStore } from "../lib/govdb/govdb.ts";
import { verbContract, wantsJson } from "./json-out.ts";
import { dim } from "./shared.ts";

// W2569: the executor-cv machine contract — same fold, both faces.
const executorCvContract = verbContract({
	applied: z.boolean(),
	rows: z.array(
		z.object({
			key: z.string(),
			cv: z.number(),
			valid: z.number().int(),
			invalid: z.number().int(),
		}),
	),
});

const close = (store: { close?: () => void }): void => store.close?.();

export async function cmdExecutorCv(rest: string[]): Promise<void> {
	const apply = rest.includes("--apply");
	const store = openStore();
	try {
		const tally = executorCv(store);
		if (apply) writeExecutorCvFacts(store, tally);
		const rows = [...tally.entries()]
			.sort((a, b) => a[1].cv - b[1].cv)
			.map(([key, t]) => ({
				key,
				cv: t.cv,
				valid: t.valid,
				invalid: t.invalid,
			}));
		if (wantsJson(rest)) {
			executorCvContract.emit({
				schema_version: 1,
				verb: "executor-cv",
				applied: apply,
				rows,
			});
			return;
		}
		if (!rows.length) {
			console.log(
				dim(
					"(no attributable results yet — dispatches stamp lane.<sid>.executor facts from now on)",
				),
			);
			return;
		}
		const width = Math.max(...rows.map((r) => r.key.length));
		console.log(
			`${"CLASS".padEnd(width)}  CV  OK  BAD  ${dim("(key = executor.<host>.<model>)")}`,
		);
		for (const r of rows) {
			console.log(
				`${r.key.padEnd(width)}  ${String(r.cv).padStart(2)}  ${String(r.valid).padStart(2)}  ${String(r.invalid).padStart(2)}`,
			);
		}
	} finally {
		close(store);
	}
}

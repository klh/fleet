// hooks/coord/executor-cv.ts — W620: `coord executor-cv` — the executor
// trust tally surfaced as a verb. The fold prints (worst first); `--apply`
// banks it as facts executor.<host>.<model>.cv. Dispatch already folds +
// banks automatically on every spawn cycle; this verb is the operator's
// measure view (board/monitor read the same facts).
import { openStore } from "../lib/govdb.ts";
import { dim } from "./shared.ts";
import {
	executorCv,
	writeExecutorCvFacts,
} from "../lib/executor-cv.ts";

const close = (store: { close?: () => void }): void => store.close?.();

export async function cmdExecutorCv(rest: string[]): Promise<void> {
	const apply = rest.includes("--apply");
	const store = openStore();
	try {
		const tally = executorCv(store);
		if (apply) writeExecutorCvFacts(store, tally);
		const rows = [...tally.entries()].sort((a, b) => a[1].cv - b[1].cv);
		if (!rows.length) {
			console.log(
				dim(
					"(no attributable results yet — dispatches stamp lane.<sid>.executor facts from now on)",
				),
			);
			return;
		}
		const width = Math.max(...rows.map(([k]) => k.length));
		console.log(
			`${"CLASS".padEnd(width)}  CV  OK  BAD  ${dim("(key = executor.<host>.<model>)")}`,
		);
		for (const [key, t] of rows) {
			console.log(
				`${key.padEnd(width)}  ${String(t.cv).padStart(2)}  ${String(t.valid).padStart(2)}  ${String(t.invalid).padStart(2)}`,
			);
		}
	} finally {
		close(store);
	}
}

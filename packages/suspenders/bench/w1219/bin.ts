// bench/w1219/bin.ts — the bench CLI entry. Assembles the three candidates,
// runs the benchmark over the sink replica, writes results/run-<ts>.json and
// prints the decision table. The cloud leg's buckle key is minted + revoked.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBench } from "./runner.ts";
import {
	ollamaCandidate,
	openaiCandidate,
	anthropicCandidate,
	type Candidate,
} from "./candidates.ts";
import {
	adminKey,
	mintLaneKey,
	revokeLaneKey,
	BUCKLE_FRONT,
} from "../../hooks/lib/lane-auth.ts";

const RESULTS_DIR = join(import.meta.dir, "results");

function print(summaries: Awaited<ReturnType<typeof runBench>>): void {
	for (const s of summaries) {
		console.log(
			`${s.name}\texec=${(s.execRate * 100).toFixed(0)}%\t` +
				`match=${(s.matchRate * 100).toFixed(0)}%\t` +
				`p50=${s.p50Ms}ms\tp95=${s.p95Ms}ms`,
		);
	}
}

if (import.meta.main) {
	const admin = adminKey();
	const minted = admin ? await mintLaneKey("w1219-sql-bench", admin) : null;
	const cloud = minted
		? [
				anthropicCandidate(
					BUCKLE_FRONT,
					"glm-5.3-flash",
					"glm-5.3-flash@cloud",
					minted.key,
				),
			]
		: [];
	const candidates: Candidate[] = [
		ollamaCandidate("http://nas.threads.dk:11434", "sqlcoder"),
		openaiCandidate(
			"http://127.0.0.1:8902",
			"mlx-community/Qwen3-4B-Instruct-2507-4bit",
			"qwen3-4b@swarm-extract",
		),
		...cloud,
	];
	mkdirSync(RESULTS_DIR, { recursive: true });
	const summaries = await runBench(candidates);
	const file = join(RESULTS_DIR, `run-${new Date().toISOString()}.json`);
	writeFileSync(file, `${JSON.stringify(summaries, null, 2)}\n`);
	print(summaries);
	console.log(`results: ${file}`);
	if (admin && minted) await revokeLaneKey(minted.keyId, admin);
}

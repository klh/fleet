// bin/shadow-week.ts — the W144 shadow-week monitor (launchd-friendly,
// StartInterval daily): (a) runs the W143 bench (n=600) with the LiteLLM
// baseline recorded honestly (a down fallback is a recorded state, never a
// faked baseline), (b) diffs the day's bench JSONL against the prior day's,
// scenario-name keyed, tolerance flags on the gate metrics, (c) appends a
// bounded 7-day shadow-week log.
//
//	bun bin/shadow-week.ts [--shadow-dir DIR] [--skip-bench] [--bench-n 600]
//
// Env: BUCKLE_SHADOW_DIR (default <repo>/shadow), BUCKLE_LITELLM_URL,
// BUCKLE_SHADOW_LOG, BUCKLE_SHADOW_URL (the shadow port probed for
// availability). Exit 1 on a hard flag (gate regression, byte identity
// < 100, bench failure) so a launcher notices; soft flags (tolerance drift,
// availability change) report but exit 0.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";

// ── args + env ──
const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const REPO = new URL("..", import.meta.url).pathname;
const SHADOW_DIR =
	arg("shadow-dir") ?? process.env.BUCKLE_SHADOW_DIR ?? `${REPO}/shadow`;
const LITELLM =
	arg("litellm") ?? process.env.BUCKLE_LITELLM_URL ?? "http://127.0.0.1:4100";
const SHADOW_URL =
	arg("shadow-url") ?? process.env.BUCKLE_SHADOW_URL ?? "http://127.0.0.1:4101";
const LOG =
	arg("shadow-log") ??
	process.env.BUCKLE_SHADOW_LOG ??
	`${SHADOW_DIR}/shadow-week.jsonl`;
const N = Number(arg("bench-n") ?? 600);

import {
	DAY_MS,
	boundKeep,
	dayKey,
	diffDay,
	parseBenchRows,
} from "../src/shadow-week.ts";

async function shadowUp(url: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/status`, {
			signal: AbortSignal.timeout(2500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	mkdirSync(SHADOW_DIR, { recursive: true });
	const now = new Date();
	const day = dayKey(now);
	const dated = `${SHADOW_DIR}/${day}.jsonl`;

	// (a) the day's bench run — rm first so re-runs are idempotent
	if (!has("skip-bench")) {
		try {
			rmSync(dated, { force: true });
			const proc = Bun.spawn({
				cmd: [
					"bun",
					"bin/bench.ts",
					"--n",
					String(N),
					"--litellm",
					LITELLM,
					"--out",
					dated,
				],
				cwd: REPO,
				stdout: "ignore",
				stderr: "inherit",
			});
			const code = await proc.exited;
			if (code !== 0)
				console.error(
					`shadow-week: bench exited ${String(code)} (recorded honestly)`,
				);
		} catch (e) {
			console.error(
				`shadow-week: bench spawn failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// (b) diff vs prior day
	const priorDate = dayKey(new Date(now.getTime() - DAY_MS));
	const priorPath = `${SHADOW_DIR}/${priorDate}.jsonl`;
	const today = existsSync(dated)
		? parseBenchRows(readFileSync(dated, "utf8"))
		: [];
	const prior = existsSync(priorPath)
		? parseBenchRows(readFileSync(priorPath, "utf8"))
		: [];
	const flagged = diffDay(today, prior);
	const hardFlags = flagged.filter((f) => f.hard && f.flags.length > 0);
	const softFlags = flagged.filter((f) => !f.hard && f.flags.length > 0);
	const litellmRow = today.find((r) => r.scenario === "litellm-nonstream");
	const shadow4101 = await shadowUp(SHADOW_URL);

	// (c) bounded shadow-week log
	const ts = now.toISOString();
	const dayRow = {
		ts,
		lane: "W144",
		kind: "day",
		date: day,
		shadow_port_up: shadow4101,
		bench_rows: today.length,
		litellm_available: litellmRow?.available ?? null,
		hard_flags: hardFlags.length,
		soft_flags: softFlags.length,
	};
	const existing = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n") : [];
	const kept = boundKeep(
		existing.filter((l) => l.trim().length > 0),
		now.getTime(),
	);
	// one authoritative day row per date: later runs replace the earlier
	const keptDays = kept.filter((l) => {
		try {
			const r = JSON.parse(l) as { kind?: string; date?: string };
			return !(r.kind === "day" && r.date === day);
		} catch {
			return true;
		}
	});
	keptDays.push(JSON.stringify(dayRow));
	for (const f of flagged) {
		if (f.flags.length === 0) continue;
		const r = today.find((x) => x.scenario === f.scenario);
		keptDays.push(
			JSON.stringify({
				ts,
				lane: "W144",
				kind: "flag",
				date: day,
				scenario: f.scenario,
				flags: f.flags,
				hard: f.hard,
				p50_ms: r?.p50_ms ?? null,
				p95_ms: r?.p95_ms ?? null,
				byte_identity_pct: r?.byte_identity_pct ?? null,
				available: r?.available ?? null,
			}),
		);
	}
	writeFileSync(LOG, `${keptDays.join("\n")}\n`);

	// human summary on stderr (stdout stays clean for launchd)
	console.error(
		`shadow-week ${day}: bench_rows=${String(today.length)} shadow_port_up=${String(shadow4101)} litellm_available=${String(litellmRow?.available ?? "n/a")} hard=${String(hardFlags.length)} soft=${String(softFlags.length)} log=${LOG}`,
	);
	for (const f of [...hardFlags, ...softFlags])
		console.error(
			`  ${f.hard ? "HARD" : "soft"}  ${f.scenario}: ${f.flags.join("; ")}`,
		);
	if (prior.length === 0)
		console.error("  (first day — no prior-day diff; baseline begins today)");
	if (hardFlags.length > 0) process.exit(1);
}

if (import.meta.main) await main();

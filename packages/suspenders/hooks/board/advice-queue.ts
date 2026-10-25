// hooks/board/advice-queue.ts — the /api/advise worker queue (W667 dedupe
// window, launchd-replay recovery, one-at-a-time runner) — W1298: moved
// verbatim out of routes-actions so the near-cap route module decomposes by
// responsibility.
import { db, CLI } from "./context.ts";
import { json } from "./helpers.ts";
import { pidAlive } from "./lanes.ts";

// W667: /api/advise dedupe window — the detached advise child can run
// minutes (belt leg timeout 300s); within this window re-clicks and UI
// backoff retries ride the in-flight child (inFlight:true) instead of
// stacking spawns. advise.ts clears the stamp on its terminal writes.
const ADVISE_INFLIGHT_MS = 120_000;
const adviceQueue: number[] = [];
const adviceQueued = new Set<number>();
let adviceRunning = false;
const advicePidKey = (id: number) => `advice.${id}.workerPid`;

/** launchd can terminate advice workers with the board; replay those requests. */
export function recoverPendingAdvice(): void {
	const rows = db
		.query("SELECT key FROM facts WHERE key GLOB 'advice.*.requested'")
		.all() as { key: string }[];
	for (const row of rows) {
		const id = Number(/^advice\.(\d+)\.requested$/.exec(row.key)?.[1]);
		if (!Number.isSafeInteger(id) || id <= 0) continue;
		const outcome = db
			.query("SELECT key FROM facts WHERE key IN (?, ?) LIMIT 1")
			.get(`advice.${id}`, `advice.${id}.error`);
		if (outcome) {
			db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
				row.key,
				advicePidKey(id),
			);
			continue;
		}
		const pidRow = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(advicePidKey(id)) as { value: string } | null;
		if (pidRow && pidAlive(Number(pidRow.value))) continue;
		adviceQueue.push(id);
		adviceQueued.add(id);
	}
	runNextAdvice();
}

// The pinned local-reason leg has only two slots, shared with agents. Board
// clicks run one at a time rather than flooding that model with 503s.
export function runNextAdvice(): void {
	if (adviceRunning) return;
	const id = adviceQueue.shift();
	if (id === undefined) return;
	adviceRunning = true;
	db.query("UPDATE facts SET value = 'running', ts = ? WHERE key = ?").run(
		Date.now(),
		`advice.${id}.requested`,
	);
	try {
		const child = Bun.spawn(
			[process.execPath, CLI("advise.ts"), String(id), "--panel"],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		const pending = db
			.query("SELECT key FROM facts WHERE key = ?")
			.get(`advice.${id}.requested`);
		if (pending)
			db.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
			).run(advicePidKey(id), String(child.pid), Date.now());
		void child.exited.then(
			(code) =>
				finishAdvice(id, code === 0 ? null : `advice worker exited ${code}`),
			(error: unknown) =>
				finishAdvice(
					id,
					error instanceof Error ? error.message : String(error),
				),
		);
	} catch (error) {
		finishAdvice(id, error instanceof Error ? error.message : String(error));
	}
}

export function finishAdvice(id: number, failure: string | null): void {
	const key = `advice.${id}`;
	const outcome = db
		.query("SELECT key FROM facts WHERE key IN (?, ?) LIMIT 1")
		.get(key, `${key}.error`) as { key: string } | null;
	if (!outcome)
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
		).run(
			`${key}.error`,
			failure ?? "advice worker stopped without a result",
			Date.now(),
		);
	db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
		`${key}.requested`,
		advicePidKey(id),
	);
	adviceQueued.delete(id);
	adviceRunning = false;
	runNextAdvice();
}

// W1298: the /api/advise route's queueing tail, folded in so the queue
// mechanics stay one module (moved verbatim from the route block).
export function enqueueAdvice(id: number): Response {
	const stamp = `advice.${id}.requested`;
	const inflight = db
		.query("SELECT ts FROM facts WHERE key = ?")
		.get(stamp) as { ts: number } | null;
	if (
		adviceQueued.has(id) ||
		(inflight && Date.now() - inflight.ts < ADVISE_INFLIGHT_MS)
	)
		return json({ ok: true, started: false, inFlight: true });
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'fleet-board', 1, ?)",
	).run(stamp, adviceRunning ? "queued" : "running", Date.now());
	db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
		`advice.${id}`,
		`advice.${id}.error`,
	);
	adviceQueue.push(id);
	adviceQueued.add(id);
	const queued = adviceRunning;
	runNextAdvice();
	return json({ ok: true, started: !queued, queued });
}

// test/subscribe-registry.test.ts — W417.3: the lane-subscribe lifecycle.
// End-to-end through the real CLIs against an isolated temp HOME (fresh
// governor.db, GOVERNOR_STORE_URL=local): cmdSubscribe self-registers its
// pid; `work done`/release reap the owner's subscriber when the sid owns no
// other active work; `coord gc` sweeps transcript-stale subscribers. The
// repo checkout under test must live outside /tmp for project identity, so
// the temp git repo is created under process.cwd() (same law as
// work-cli.test.ts).

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	reapSubscribe,
	registerSubscribe,
	unregisterSubscribe,
} from "../hooks/lib/subscribe-registry.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-sub-registry-home-"));
mkdirSync(join(HOME, ".claude-insights"), { recursive: true });
// the raw-Database readers below must not race the first CLI's mkdir
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });
mkdirSync(join(HOME, ".claude", "projects"), { recursive: true });
const REPO = mkdtempSync(join(tmpdir(), "suspenders-sub-registry-repo-"));
if (
	Bun.spawnSync(["git", "init", "-q", REPO], {
		stdout: "ignore",
		stderr: "ignore",
	}).exitCode !== 0
)
	throw new Error(`git init failed in ${REPO}`);
const env = { ...process.env, HOME, GOVERNOR_STORE_URL: "local" };
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

function withDb(fn: (db: Database) => void): void {
	const db = new Database(DB, { create: true });
	db.run("PRAGMA busy_timeout=2000");
	fn(db);
	db.close();
}

const factValue = (sid: string): string | null => {
	let out: string | null = null;
	withDb((db) => {
		const row = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`lane.${sid}.subscribe`) as { value: string } | undefined;
		out = row?.value ?? null;
	});
	return out;
};

const factExists = (sid: string): boolean => factValue(sid) !== null;

function spawnCli(
	file: string,
	args: string[],
): { proc: Bun.Subprocess; wait: Promise<number> } {
	const proc = Bun.spawn(["bun", join(BIN, file), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { proc, wait: proc.exited };
}

function runCli(
	file: string,
	...args: string[]
): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, file), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return fn();
}

/** Resolves true when the process exits inside the window. */
function died(proc: Bun.Subprocess, ms = 8000): Promise<boolean> {
	return Promise.race([
		proc.exited.then(() => true),
		new Promise<boolean>((r) => {
			setTimeout(() => r(false), ms);
		}),
	]);
}

const strays: Bun.Subprocess[] = [];
const spawnSubscriber = (
	sid: string,
): { proc: Bun.Subprocess; wait: Promise<number> } => {
	const s = spawnCli("coord.ts", ["subscribe", "--as", sid]);
	strays.push(s.proc);
	return s;
};
const spawnSleeper = (): Bun.Subprocess =>
	Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });

const transcript = (sid: string): string =>
	join(HOME, ".claude", "projects", "sub-registry", `${sid}.jsonl`);

const freshTranscript = (sid: string): void => {
	const p = transcript(sid);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, "{}\n");
};

const idOf = (out: string): string =>
	(out.match(/W\d+(?:\.\d+)*/) ?? [])[0] ?? "";

const work = (...args: string[]) => runCli("work.ts", ...args);

// the raw-Database unit tests need the schema the CLIs get from
// openGovernorDb's migrations — one gc primes the fresh temp db
beforeAll(() => {
	const gc = runCli("coord.ts", "gc");
	if (gc.code !== 0) throw new Error(`gc prime failed: ${gc.err}`);
});

afterAll(() => {
	for (const p of strays) {
		try {
			p.kill();
		} catch {}
	}
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("subscribe registry units", () => {
	test("register/unregister round-trips the fact row", () => {
		withDb((db) => {
			registerSubscribe(db as never, "sub-reg-rt", 424242);
			const row = db
				.query("SELECT value, source FROM facts WHERE key = ?")
				.get("lane.sub-reg-rt.subscribe") as
				| { value: string; source: string }
				| undefined;
			expect(row).toBeDefined();
			const parsed = JSON.parse(row?.value ?? "{}") as { pid: number };
			expect(parsed.pid).toBe(424242);
			expect(row?.source).toBe("sub-reg-rt");
			unregisterSubscribe(db as never, "sub-reg-rt");
			expect(
				db
					.query("SELECT 1 FROM facts WHERE key = ?")
					.get("lane.sub-reg-rt.subscribe"),
			).toBeNull();
		});
	});

	test("reap with no registry row is absent", () => {
		withDb((db) => {
			expect(reapSubscribe(db as never, "sub-absent")).toBe("absent");
		});
	});

	test("reap a dead pid unregisters without signalling", async () => {
		const sleeper = spawnSleeper();
		await new Promise((r) => setTimeout(r, 100));
		sleeper.kill();
		await sleeper.exited;
		const sid = "sub-dead-pid";
		withDb((db) => {
			db.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?)",
			).run(`lane.${sid}.subscribe`, JSON.stringify({ pid: sleeper.pid }), sid, Date.now());
			expect(reapSubscribe(db as never, sid)).toBe("unregistered");
			expect(
				db.query("SELECT 1 FROM facts WHERE key = ?").get(`lane.${sid}.subscribe`),
			).toBeNull();
		});
	});

	test("a recycled pid is unregistered, never signalled", async () => {
		const impostor = spawnSleeper();
		strays.push(impostor);
		const sid = "sub-recycled";
		withDb((db) => {
			db.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?)",
			).run(
				`lane.${sid}.subscribe`,
				JSON.stringify({ pid: impostor.pid }),
				sid,
				Date.now(),
			);
			// the impostor's args ("sleep 60") do not anchor the sid — the row
			// drops and the foreign process must survive
			expect(reapSubscribe(db as never, sid)).toBe("unregistered");
		});
		expect(factExists(sid)).toBe(false);
		expect(await died(impostor, 500)).toBe(false);
		impostor.kill();
	});

	test("a foreign-host subscriber is kept untouched", () => {
		const sid = "sub-foreign-host";
		withDb((db) => {
			db.query(
				"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?)",
			).run(
				`lane.${sid}.subscribe`,
				JSON.stringify({ pid: process.pid, host: "some-other-host" }),
				sid,
				Date.now(),
			);
			expect(reapSubscribe(db as never, sid, { staleOnly: true })).toBe(
				"kept",
			);
		});
		expect(factExists(sid)).toBe(true);
	});
});

describe("live subscriber lifecycle", () => {
	test("cmdSubscribe self-registers; a terminal reap signals it", async () => {
		const sid = "sub-live";
		const sub = spawnSubscriber(sid);
		expect(await waitFor(() => factExists(sid))).toBe(true);
		expect(sub.wait).toBeDefined();
		withDb((db) => {
			expect(reapSubscribe(db as never, sid)).toBe("signalled");
		});
		expect(await died(sub.proc)).toBe(true);
		expect(await waitFor(() => !factExists(sid))).toBe(true);
	});

	test("coord gc sweeps a transcript-stale subscriber", async () => {
		const sid = "sub-gc-dead";
		const sub = spawnSubscriber(sid);
		expect(await waitFor(() => factExists(sid))).toBe(true);
		const gc = runCli("coord.ts", "gc");
		expect(gc.code).toBe(0);
		expect(gc.out).toContain("subscribes reaped");
		expect(await died(sub.proc)).toBe(true);
		expect(await waitFor(() => !factExists(sid))).toBe(true);
	});

	test("coord gc keeps a subscriber whose transcript is fresh", async () => {
		const sid = "sub-gc-keep";
		const sub = spawnSubscriber(sid);
		expect(await waitFor(() => factExists(sid))).toBe(true);
		// the gc SUBPROCESS (temp HOME) sees the fresh temp transcript — an
		// in-process sweep scans the runner's real HOME and would signal
		freshTranscript(sid);
		const gc = runCli("coord.ts", "gc");
		expect(gc.code).toBe(0);
		expect(gc.out).toContain("0 subscribes reaped");
		expect(await died(sub.proc, 800)).toBe(false); // still watching its lane
		expect(factExists(sid)).toBe(true);
		sub.proc.kill();
		await sub.proc.exited;
	});

	test("work done reaps only when the sid owns no other active work", async () => {
		const sid = "sub-idle-guard";
		const addA = work("add", "idle guard A", "--desc", "w417.3");
		const addB = work("add", "idle guard B", "--desc", "w417.3");
		expect(addA.err).toBe("");
		expect(addB.err).toBe("");
		const idA = idOf(addA.out);
		const idB = idOf(addB.out);
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();
		expect(work("take", idA, "--as", sid).code).toBe(0);
		expect(work("take", idB, "--as", sid).code).toBe(0);
		const sub = spawnSubscriber(sid);
		expect(await waitFor(() => factExists(sid))).toBe(true);
		// first done: idB is still CLAIMED — the subscribe must survive
		expect(work("done", idA, "--sha", "sha-a").code).toBe(0);
		expect(await died(sub.proc, 800)).toBe(false);
		expect(factExists(sid)).toBe(true);
		// second done: nothing left owned — the subscribe follows it out
		expect(work("done", idB, "--sha", "sha-b").code).toBe(0);
		expect(await died(sub.proc)).toBe(true);
		expect(await waitFor(() => !factExists(sid))).toBe(true);
	});

	test("work release reaps the owner's subscriber", async () => {
		const sid = "sub-release";
		const id = idOf(work("add", "release reap", "--desc", "w417.3").out);
		expect(id).toBeTruthy();
		expect(work("take", id, "--as", sid).code).toBe(0);
		const sub = spawnSubscriber(sid);
		expect(await waitFor(() => factExists(sid))).toBe(true);
		expect(work("release", id, "--as", sid).code).toBe(0);
		expect(await died(sub.proc)).toBe(true);
		expect(await waitFor(() => !factExists(sid))).toBe(true);
	});
});

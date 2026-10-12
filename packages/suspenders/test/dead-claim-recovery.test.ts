import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	observeDeadClaim,
	attemptRecovery,
	reserveRecovery,
	resetRecovery,
	recordRecoveryResult,
} from "../hooks/lib/dead-claim-recovery.ts";

test("automatic watchdog cannot invoke bulk reclaim or publish unverified reclaim success", () => {
	const source = readFileSync(
		new URL("../hooks/bin/fleet-loop.ts", import.meta.url),
		"utf8",
	);
	const watchdog = source.slice(
		source.indexOf("function stallWatch()"),
		source.indexOf("// per-lane episode"),
	);
	expect(watchdog).not.toMatch(/"reclaim",\s*"all"/);
	expect(watchdog).toContain('recovery === "released"');
});

const observation = {
	lane: { sid: "owner", item: "W1", pid: 123, host: "local" },
	localHost: "local",
	owner: "owner",
	revision: 1,
	identity: false as boolean | null,
	transcriptFresh: false,
	now: 1_000_000,
};
test("death grace ignores old live stall clocks and restarts on renewal/transfer/unknown", () => {
	const first = observeDeadClaim(undefined, observation);
	expect(first.action).toBe("grace");
	expect(first.episode.firstConfirmedDeadAt).toBe(observation.now);
	expect(
		observeDeadClaim(first.episode, {
			...observation,
			now: observation.now + 599999,
		}).action,
	).toBe("grace");
	expect(
		observeDeadClaim(first.episode, {
			...observation,
			now: observation.now + 600000,
		}).action,
	).toBe("quarantine");
	for (const change of [
		{ revision: 2 },
		{ owner: "new-owner" },
		{ identity: null },
	]) {
		const reset = observeDeadClaim(first.episode, {
			...observation,
			...change,
			now: observation.now + 900000,
		});
		expect(reset.action).not.toBe("quarantine");
	}
});
test("remote, absent-host/PID, unknown process and fresh transcript never authorize recovery", () => {
	for (const change of [
		{ lane: { ...observation.lane, host: "remote" } },
		{ lane: { ...observation.lane, host: undefined } },
		{ lane: { ...observation.lane, pid: undefined } },
		{ identity: null },
		{ transcriptFresh: true },
	])
		expect(
			observeDeadClaim(undefined, { ...observation, ...change }).action,
		).toBe("hold");
});

test("confirmed live identity still participates in stall observation with a fresh transcript", () => {
	expect(
		observeDeadClaim(undefined, {
			...observation,
			identity: true,
			transcriptFresh: true,
		}).action,
	).toBe("live");
});
function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	return db as unknown as GovernorStore;
}
const claim = { project: "project", id: "W1", owner: "owner", revision: 1 };
const ready = () => ({
	project: "project",
	id: "W1",
	state: "READY",
	owner_sid: null,
});
const released = () => ({
	code: 0,
	out: JSON.stringify({
		project: "project",
		id: "W1",
		previousOwner: "owner",
		previousUpdatedAt: 1,
		released: true,
	}),
});

test("new owner/revision and live/unknown observations reset episode notices independently of durable budget", () => {
	const prior = {
		owner: "owner",
		revision: 1,
		firstConfirmedDeadAt: 1,
		quarantined: true,
		lastRecoveryResult: "exhausted" as const,
	};
	for (const change of [
		{ revision: 2 },
		{ identity: true },
		{ identity: null },
		{ transcriptFresh: true },
	]) {
		const next = observeDeadClaim(prior, { ...observation, ...change });
		expect(next.episode.quarantined).toBeUndefined();
		expect(next.episode.lastRecoveryResult).toBeUndefined();
	}
	const transfer = observeDeadClaim(prior, {
		...observation,
		owner: "new",
		lane: { ...observation.lane, sid: "new" },
	});
	expect(transfer.action).toBe("grace");
	expect(transfer.notify).toBe(true);
	const episode = { owner: "owner", revision: 1 };
	expect(recordRecoveryResult(episode, "held")).toBe(true);
	expect(recordRecoveryResult(episode, "held")).toBe(false);
	expect(recordRecoveryResult(episode, "exhausted")).toBe(true);
	expect(recordRecoveryResult(episode, "exhausted")).toBe(false);
});
test("retry ledger caps poison recovery across owners, revision changes and supervisor restart", () => {
	const store = fixture();
	for (let n = 0; n < 3; n++)
		expect(reserveRecovery(store, "project", "W1", `owner${n}`, n)).toBe(true);
	expect(reserveRecovery(store, "project", "W1", "another", 99)).toBe(false);
	expect(reserveRecovery(store, "other-project", "W1", "another", 99)).toBe(
		true,
	);
	resetRecovery(store, "project", "W1");
	expect(reserveRecovery(store, "project", "W1", "another", 99)).toBe(true);
	store.close();
});
test("recheck death after reservation and fail closed on errors/forged receipt/new ownership", () => {
	const cases = [
		{ dead: () => false, reclaim: released, after: ready },
		{
			dead: () => true,
			reclaim: () => ({ code: 1, out: released().out }),
			after: ready,
		},
		{
			dead: () => true,
			reclaim: () => ({ code: 0, out: '{"released":true}' }),
			after: ready,
		},
		{
			dead: () => true,
			reclaim: released,
			after: () => ({ ...ready(), state: "CLAIMED", owner_sid: "new-owner" }),
		},
	];
	for (const c of cases) {
		const store = fixture();
		expect(attemptRecovery(store, claim, c.dead, c.reclaim, c.after)).toBe(
			"held",
		);
		expect(
			store.query("SELECT attempts FROM work_recovery_attempts").get(),
		).toEqual({ attempts: 1 });
		store.close();
	}
	const store = fixture();
	expect(attemptRecovery(store, claim, () => true, released, ready)).toBe(
		"released",
	);
	store.close();
});

// test/work-claim-fence.test.ts — W609 claim-epoch fencing: take mints the
// epoch, done/fail/start CAS on it, and a zombie writer (guard read raced a
// reclaim + re-take) is refused loudly. Same harness as work-cli.test.ts:
// isolated temp HOME (fresh governor.db) + a temp GIT repo for project
// identity — never /tmp checkouts (bash gate exempts /tmp by design).

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transition } from "../hooks/lib/work-fence.ts";

setDefaultTimeout(20_000);

const HOME = mkdtempSync(join(tmpdir(), "w609-fence-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w609-fence-repo-"));
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO]);
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = { ...process.env, HOME };

function work(...args: string[]): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

/** add + take → { id, epoch } for a fresh claim by sid. */
function claim(title: string, sid: string): { id: string; epoch: number } {
	work("add", title);
	const id = (work("ready").out.match(/W\d+(?:\.\d+)*/) ?? [])[0];
	const t = work("take", id, "--as", sid);
	if (t.code !== 0) throw new Error(`take failed: ${t.err}`);
	const epoch = Number((t.out.match(/epoch (\d+)/) ?? [])[1]);
	return { id, epoch };
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("W609 claim-epoch fencing", () => {
	test("take mints claim_epoch and re-take increments it", () => {
		const a = claim("fence mint", "laneA");
		expect(a.epoch).toBe(1);
		work("release", a.id, "--as", "laneA");
		const b = work("take", a.id, "--as", "laneB");
		expect(b.code).toBe(0);
		expect(Number((b.out.match(/epoch (\d+)/) ?? [])[1])).toBe(2);
	});

	test("zombie done with a stale epoch is fenced loudly, claim intact", () => {
		// the zombie disease: owner survives a reclaim + re-take by the SAME
		// sid, so only the epoch distinguishes the stale guard read
		const { id, epoch } = claim("fence zombie", "laneZ");
		work("release", id, "--as", "laneZ");
		work("take", id, "--as", "laneZ"); // epoch now epoch+1, owner unchanged
		const stale = work(
			"done",
			id,
			"--sha",
			"abc1234",
			"--as",
			"laneZ",
			"--claim-epoch",
			String(epoch),
		);
		expect(stale.code).not.toBe(0);
		expect(stale.err).toContain("fenced off");
		expect(stale.err).toContain(`epoch=${epoch}`);
		expect(work("show", id, "--json").out).toContain('"state":"CLAIMED"');
		// the legitimate writer — the CURRENT epoch — wins
		const fresh = work(
			"done",
			id,
			"--sha",
			"abc1234",
			"--as",
			"laneZ",
			"--claim-epoch",
			String(epoch + 1),
		);
		expect(fresh.code).toBe(0);
	});

	test("transition(): a stale guard read loses, exactly one CAS wins", async () => {
		// pin the LOCAL store: a GOVERNOR_STORE_URL in the lane env would
		// otherwise route this unit test at the live fleet store server
		const { GOVERNOR_STORE_URL: priorUrl, HOME: priorHome } = process.env;
		process.env.GOVERNOR_STORE_URL = "local";
		process.env.HOME = HOME;
		// dynamic import: govdb computes the store path from HOME at import
		// time — a static import would freeze the REAL home and point this
		// unit test at the live governor.db (measured, W609)
		const { openStore } = await import("../hooks/lib/govdb.ts");
		const store = openStore();
		store.run(
			"INSERT INTO work_items (project, id, title, state, created_at, updated_at, owner_sid, claim_epoch) VALUES ('p', 'WZ', 't', 'CLAIMED', 1, 1, 'laneU', 7)",
		);
		const staleFence = {
			project: "p",
			id: "WZ",
			states: ["CLAIMED"],
			owner: "laneU",
			epoch: 7,
		};
		// the interleaving the zombie ran: guard read, THEN reclaim + re-take
		store.run(
			"UPDATE work_items SET state='READY', owner_sid=NULL WHERE id='WZ'",
		);
		store.run(
			"UPDATE work_items SET state='CLAIMED', owner_sid='laneV', claim_epoch=claim_epoch+1 WHERE id='WZ'",
		);
		const lost = transition(store, staleFence, { state: "DONE", owner: null });
		expect(lost.ok).toBe(false);
		if (!lost.ok)
			expect(lost.message).toContain("found state=CLAIMED owner=laneV epoch=8");
		const won = transition(
			store,
			{ ...staleFence, owner: "laneV", epoch: 8 },
			{ state: "DONE", owner: null },
		);
		expect(won.ok).toBe(true);
		// a second writer after the winner is fenced by state (no epoch needed)
		const late = transition(store, staleFence, { state: "DONE", owner: null });
		expect(late.ok).toBe(false);
		store.close();
		process.env.GOVERNOR_STORE_URL = priorUrl;
		process.env.HOME = priorHome;
	});

	test("concurrent done vs done: exactly one wins, loser fenced loud", async () => {
		const { id, epoch } = claim("fence race", "laneR");
		const spawnDone = (e: number) =>
			Bun.spawn({
				cmd: [
					"bun",
					join(BIN, "work.ts"),
					"done",
					id,
					"--sha",
					"abc1234",
					"--as",
					"laneR",
					"--claim-epoch",
					String(e),
				],
				cwd: REPO,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
		const procs = [spawnDone(epoch), spawnDone(epoch)];
		const results = await Promise.all(
			procs.map(async (p) => ({
				code: await p.exited,
				err: await new Response(p.stderr).text(),
			})),
		);
		expect(results.filter((r) => r.code === 0).length).toBe(1);
		const loser = results.find((r) => r.code !== 0);
		expect(loser?.err).toContain("fenced off");
	});

	test("concurrent stale done vs fresh done: stale always loses", async () => {
		const { id, epoch } = claim("fence stale race", "laneS");
		const spawnDone = (e: number) =>
			Bun.spawn({
				cmd: [
					"bun",
					join(BIN, "work.ts"),
					"done",
					id,
					"--sha",
					"abc1234",
					"--as",
					"laneS",
					"--claim-epoch",
					String(e),
				],
				cwd: REPO,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
		// the stale-epoch writer never matches the row; the fresh one does —
		// exactly one winner under ANY interleaving
		const procs = [spawnDone(epoch), spawnDone(epoch + 1)];
		const results = await Promise.all(
			procs.map(async (p) => ({
				code: await p.exited,
				err: await new Response(p.stderr).text(),
			})),
		);
		expect(results.filter((r) => r.code === 0).length).toBe(1);
	});
});

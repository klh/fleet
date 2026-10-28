// test/work-claim-fence.test.ts — W2186 re-land of W609: take mints
// claim_epoch (+1 per READY→CLAIMED CAS, work-alloc.ts assignTask), done/
// fail/start CAS on it, and a zombie writer (guard read raced a reclaim +
// re-take) is refused loudly. done composes BOTH fences: the W643 token hash
// AND the W609 epoch in its WHERE. Same harness as work-cli.test.ts: isolated
// temp HOME (fresh governor.db) + a temp GIT repo for project identity —
// never /tmp checkouts (bash gate exempts /tmp by design).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitInit, tmpDir } from "./helpers/fixture-kit.ts";
import { transition } from "../hooks/lib/work/work-transition.ts";

setDefaultTimeout(20_000);

const HOME = tmpDir("w2186-fence-home-");
const REPO = tmpDir("w2186-fence-repo-");
gitInit(REPO, { baseline: true });
function productCommit(label: string): string {
	writeFileSync(join(REPO, "fence-product.ts"), "export const rev = 1;\n");
	Bun.spawnSync(["git", "-C", REPO, "add", "fence-product.ts"]);
	Bun.spawnSync([
		"git",
		"-C",
		REPO,
		"-c",
		"user.name=F",
		"-c",
		"user.email=f@f.f",
		"commit",
		"-qm",
		label,
	]);
	return Bun.spawnSync(["git", "-C", REPO, "rev-parse", "HEAD"])
		.stdout.toString()
		.trim();
}
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = { ...process.env, HOME };

function work(
	...args: string[]
): { out: string; err: string; code: number } {
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

/** add + take → { id, epoch, token } for a fresh claim by sid. */
function claim(
	title: string,
	sid: string,
): { id: string; epoch: number; token: string } {
	work("add", title);
	const id = (work("ready").out.match(/W\d+(?:\.\d+)*/) ?? [])[0];
	const t = work("take", id, "--as", sid);
	if (t.code !== 0) throw new Error(`take failed: ${t.err}`);
	return {
		id,
		epoch: Number((t.out.match(/claim epoch: (\d+)/) ?? [])[1]),
		token: (t.out.match(/claim token: ([0-9a-f]{48})/) ?? [])[1],
	};
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

test("take mints claim_epoch and re-take increments it", () => {
	const a = claim("fence mint", "laneA");
	expect(a.epoch).toBe(1);
	work("release", a.id, "--as", "laneA");
	const b = work("take", a.id, "--as", "laneB");
	expect(b.code).toBe(0);
	expect(Number((b.out.match(/claim epoch: (\d+)/) ?? [])[1])).toBe(2);
});

test("zombie done with stale token+epoch is refused, claim intact", () => {
	// the zombie disease: owner survives a reclaim + re-take by the SAME
	// sid, so only token+epoch distinguish the stale guard read
	const { id, epoch, token } = claim("fence zombie", "laneZ");
	work("release", id, "--as", "laneZ");
	work("take", id, "--as", "laneZ");
	const stale = work(
		"done",
		id,
		"--sha",
		productCommit("w2186 fence evidence commit"),
		"--as",
		"laneZ",
		"--token",
		token,
		"--claim-epoch",
		String(epoch),
		"--summary",
		"Zombie writer attempt: a stale token and stale epoch must be refused loudly without clobbering the replacement claim row.",
	);
	expect(stale.code).not.toBe(0);
	expect(stale.err).toContain("refused");
	expect(work("show", id, "--json").out).toContain('"state":"CLAIMED"');
});

test("the current-epoch closer wins after a zombie refusal", () => {
	const { id } = claim("fence zombie", "laneZ2");
	work("release", id, "--as", "laneZ2");
	const retake = work("take", id, "--as", "laneZ2");
	const newEpoch = Number((retake.out.match(/claim epoch: (\d+)/) ?? [])[1]);
	const newToken = (retake.out.match(/claim token: ([0-9a-f]{48})/) ?? [])[1];
	const win = work(
		"done",
		id,
		"--sha",
		productCommit("w2186 fence evidence commit"),
		"--as",
		"laneZ2",
		"--token",
		newToken,
		"--claim-epoch",
		String(newEpoch),
		"--summary",
		"Legitimate closer: current token and current epoch CAS through the double fence and land DONE cleanly.",
	);
	expect(win.code).toBe(0);
});

test("zombie fail with a stale epoch is fenced off loudly", () => {
	const { id, epoch } = claim("fence zombie fail", "laneF");
	work("release", id, "--as", "laneF");
	work("take", id, "--as", "laneF");
	const stale = work(
		"fail",
		id,
		"--as",
		"laneF",
		"--claim-epoch",
		String(epoch),
		"--note",
		"stale writer",
	);
	expect(stale.code).not.toBe(0);
	expect(stale.err).toContain("fenced off");
	expect(stale.err).toContain(`epoch=${epoch}`);
	expect(work("show", id, "--json").out).toContain('"state":"CLAIMED"');
	const ok = work("fail", id, "--as", "laneF");
	expect(ok.code).toBe(0);
});

test("transition(): a stale guard read loses, exactly one CAS wins", async () => {
	// pin the LOCAL store: a GOVERNOR_STORE_URL in the lane env would
	// otherwise route this unit test at the live governor.db; dynamic
	// import: govdb computes the store path from HOME at import time
	const { GOVERNOR_STORE_URL: priorUrl, HOME: priorHome } = process.env;
	process.env.GOVERNOR_STORE_URL = "local";
	process.env.HOME = HOME;
	const { openStore } = await import("../hooks/lib/govdb/govdb.ts");
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
	store.close();
	process.env.GOVERNOR_STORE_URL = priorUrl;
	process.env.HOME = priorHome;
});

/** two done processes race the same claim; exactly one may land. */
function raceDone(
	id: string,
	sid: string,
	a: { epoch: number; token: string },
	b: { epoch: number; token: string },
) {
	const argsOf = (e: number, tok: string) => [
		"bun",
		join(BIN, "work.ts"),
		"done",
		id,
		"--sha",
		productCommit("w2186 fence evidence commit"),
		"--as",
		sid,
		"--token",
		tok,
		"--claim-epoch",
		String(e),
		"--summary",
		"Racing closers: exactly one of two concurrent writers may land; the loser is refused loudly, never clobber.",
	];
	return Promise.all(
		[
			Bun.spawn(argsOf(a.epoch, a.token), {
				cwd: REPO,
				env,
				stdout: "pipe",
				stderr: "pipe",
			}),
			Bun.spawn(argsOf(b.epoch, b.token), {
				cwd: REPO,
				env,
				stdout: "pipe",
				stderr: "pipe",
			}),
		].map(async (p) => ({
			code: await p.exited,
			err: await new Response(p.stderr).text(),
		})),
	);
}

test("concurrent done vs done: exactly one wins, loser refused", async () => {
	const cR = claim("fence race", "laneR");
	const results = await raceDone(cR.id, "laneR", cR, cR);
	expect(results.filter((r) => r.code === 0).length).toBe(1);
	const loser = results.find((r) => r.code !== 0);
	expect(loser?.err).toContain("refused");
});

test("concurrent stale vs fresh done: stale always loses", async () => {
	const { id, epoch, token } = claim("fence stale race", "laneS");
	work("release", id, "--as", "laneS");
	const retake = work("take", id, "--as", "laneS");
	const fresh = {
		epoch: Number((retake.out.match(/claim epoch: (\d+)/) ?? [])[1]),
		token: (retake.out.match(/claim token: ([0-9a-f]{48})/) ?? [])[1],
	};
	const results = await raceDone(
		id,
		"laneS",
		{ epoch, token },
		{ epoch: fresh.epoch, token: fresh.token },
	);
	expect(results.filter((r) => r.code === 0).length).toBe(1);
});








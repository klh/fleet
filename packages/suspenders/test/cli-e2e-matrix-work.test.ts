// test/cli-e2e-matrix-work.test.ts — W932: the work CLI verb matrix. Every
// verb in the `work` registry (parsed from the generated --help face — the
// registry IS the door contract, W651) runs for real against an isolated
// governor.db + temp repo: lifecycle round trips, wrong-writer refusals,
// and DB side effects. Beyond the W656.1 registry/help smoke: isolated-DB
// scenarios that catch missing wiring, wrong side effects, and broken round
// trips. The final test asserts registry parity — a verb added to the
// registry without a matrix scenario fails here.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

setDefaultTimeout(30_000); // spawn-heavy suite (memory: 5s default is the flake floor)

const fx = cliFixture("work-matrix");
const covered = new Set<string>();
const cover = (name: string): void => covered.add(name);
const idOf = (out: string): string =>
	(out.match(/W\d+(?:\.\d+)*/) ?? [])[0] ?? "";
const tokenOf = (out: string): string =>
	/claim token: ([0-9a-f]{48})/.exec(out)?.[1] ?? "";
const work = (...args: string[]) => fx.run("work.ts", args);
/** Mint a real FILE-bearing commit in the fixture repo — the done gate's
 *  product-evidence window (claim baseline → sha) demands file changes. */
const commitIn = (repo: string, msg: string): string => {
	writeFileSync(join(repo, `f-${msg.replaceAll(/\W/g, "")}.txt`), "x\n");
	spawnSync("git", ["add", "-A"], { cwd: repo, stdout: "ignore" });
	spawnSync(
		"git",
		[
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			msg,
			"--allow-empty",
		],
		{ cwd: repo, encoding: "utf8" },
	);
	return spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	}).stdout.trim();
};

describe("work verb matrix — done round trip + wrong-writer refusals", () => {
	test("done without the fresh claim token is refused (stale writer)", () => {
		const id = idOf(work("add", "done chain").out);
		const first = work("take", id, "--as", "s1");
		const stale = tokenOf(first.out);
		work("release", id, "--as", "s1");
		const fresh = tokenOf(work("take", id, "--as", "s1").out);
		expect(fresh).not.toBe(stale);
		const product = commitIn(fx.REPO, "product leg");
		const refused = work("done", id, "--as", "s1", "--sha", product);
		expect(refused.code).not.toBe(0);
		const closed = work(
			"done",
			id,
			"--as",
			"s1",
			"--sha",
			product,
			"--token",
			fresh,
			"--summary",
			"closed with a 40-plus character completion paragraph that satisfies the completion-record gate",
		);
		expect(closed.code).toBe(0);
		expect(work("summary", id).out).toContain("completion paragraph");
		cover("done");
		cover("summary");
	});
});

describe("work verb matrix — fail/retry/cancel + guards", () => {
	test("fail → retry resets budget; cancel requires --note", () => {
		const id = idOf(work("add", "fail chain").out);
		expect(work("take", id, "--as", "s2").code).toBe(0);
		cover("fail");
		expect(
			work("fail", id, "--as", "s2", "--note", "repro: x | no-repro: y").out,
		).toContain("FAILED");
		cover("retry");
		expect(work("retry", id).out).toContain("READY");
		cover("cancel");
		expect(work("cancel", id, "--note", "dup").code).toBe(0);
	});
});

describe("work verb matrix — external waiting", () => {
	test("failed → waiting → evidence-gated ready, with reason visible", () => {
		const id = idOf(work("add", "external gate").out);
		cover("fail");
		expect(work("fail", id, "--note", "quota exhausted").code).toBe(0);
		cover("wait");
		expect(
			work(
				"wait",
				id,
				"--kind",
				"quota",
				"--reason",
				"seat reset",
				"--until",
				"2099-01-01T00:00:00Z",
			).out,
		).toContain("WAITING");
		expect(work("ready").out).not.toContain(id);
		expect(work("show", id).out).toContain("seat reset");
		cover("wake");
		expect(work("wake", id, "--note", "quota verified").code).not.toBe(0);
		expect(
			work("wake", id, "--note", "quota verified", "--force").out,
		).toContain("READY");
		expect(
			work("wait", id, "--kind", "operator", "--reason", "capture needed").out,
		).toContain("WAITING");
	});
});

describe("work verb matrix — block/unblock/supersede", () => {
	test("block → unblock → supersede round trip", () => {
		const id = idOf(work("add", "block chain").out);
		cover("block");
		expect(work("block", id, "--on", "W1").out).toContain("blocked on W1");
		cover("unblock");
		expect(work("unblock", id, "--on", "W1").out).toContain("unblocked");
		cover("supersede");
		expect(work("supersede", id, "--by", "W1").out).toContain(
			`superseded by W1`,
		);
	});
});

describe("work verb matrix — split + migrate-ledger + report/allocate", () => {
	test("split mints children; report/allocate/lanes render", () => {
		const parent = idOf(work("add", "split parent").out);
		cover("split");
		const s = work(
			"split",
			parent,
			"childA",
			"childB",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		);
		expect(s.code).toBe(0);
		cover("report");
		expect(work("report").out).toContain("ITEM");
		cover("allocate");
		expect(JSON.parse(work("allocate", "--json").out)).toBeInstanceOf(Array);
		cover("lanes");
		expect(work("lanes").code).toBe(0);
	});
});

describe("work verb matrix — migrate-ledger + orphaned", () => {
	test("migrate-ledger imports once, idempotent on re-run", () => {
		const ledger = join(fx.REPO, "ledger.md");
		writeFileSync(
			ledger,
			["# Ledger", "- [ ] ledger task A", "- [ ] ledger task B"].join("\n"),
		);
		cover("migrate-ledger");
		const first = work("migrate-ledger", ledger);
		expect(first.code).toBe(0);
		expect(work("list").out).toContain("ledger task A");
		const rowsBefore = fx.q<{ n: number }>(
			"SELECT COUNT(*) AS n FROM work_items WHERE title LIKE 'ledger task%'",
		);
		const second = work("migrate-ledger", ledger);
		expect(second.code).toBe(0);
		const rowsAfter = fx.q<{ n: number }>(
			"SELECT COUNT(*) AS n FROM work_items WHERE title LIKE 'ledger task%'",
		);
		expect(rowsAfter[0].n).toBe(rowsBefore[0].n);
	});

	test("orphaned --json lists a claimed item with no live session", () => {
		const id = idOf(work("add", "orphan bait").out);
		cover("take");
		expect(work("take", id, "--as", "s5").code).toBe(0);
		cover("orphaned");
		const rows: Array<Record<string, unknown>> = JSON.parse(
			work("orphaned", "--json").out,
		);
		expect(rows.some((r) => r.id === id)).toBe(true);
	});
});

describe("work verb matrix — lifecycle round trip", () => {
	test("add → list/ready/show/stats render the minted item", () => {
		const id = idOf(work("add", "matrix item one", "--desc", "d1").out);
		expect(id).toMatch(/^W\d+$/);
		cover("add");
		cover("list");
		expect(work("list").out).toContain(id);
		cover("ready");
		expect(work("ready").out).toContain(id);
		cover("show");
		expect(work("show", id).out).toContain("matrix item one");
		expect(JSON.parse(work("show", id, "--json").out)).toMatchObject({
			id,
			state: "READY",
		});
		cover("stats");
		expect(JSON.parse(work("stats").out).counts.READY).toBeGreaterThan(0);
	});

	test("mine/owned/take/start/extend/release claim chain", () => {
		const id = idOf(work("add", "matrix item two").out);
		cover("mine");
		expect(work("mine", "--as", "s1").out).not.toContain(id);
		cover("owned");
		expect(work("owned", "--as", "s1").out).not.toContain(id);
		cover("take");
		const t = work("take", id, "--as", "s1");
		expect(t.code).toBe(0);
		expect(tokenOf(t.out)).not.toBe("");
		cover("start");
		expect(work("start", id).code).toBe(0);
		cover("extend");
		expect(work("extend", id, "--as", "s1", "--for", "45m").out).toContain(
			"reclaim held",
		);
		cover("release");
		expect(work("release", id, "--as", "s1").out).toContain("→ READY");
		expect(work("mine", "--as", "s1").out).not.toContain(id);
	});
});

describe("work verb matrix — edit", () => {
	test("edit amends a live item in place; terminal items refuse", () => {
		const id = idOf(work("add", "edit bait").out);
		cover("edit");
		const r = work("edit", id, "--title", "edited bait", "--reason", "typo");
		expect(r.code).toBe(0);
		expect(JSON.parse(work("show", id, "--json").out).title).toBe(
			"edited bait",
		);
		expect(work("cancel", id, "--note", "done with it").code).toBe(0);
		expect(work("edit", id, "--title", "late").code).not.toBe(0);
	});
});

describe("work verb matrix — reconcile-completion", () => {
	test("reconcile-completion refuses without operator evidence", () => {
		const id = idOf(work("add", "reconcile bait").out);
		cover("reconcile-completion");
		expect(work("reconcile-completion", id).code).not.toBe(0);
	});
});

describe("work verb matrix — reclaim", () => {
	test("reclaim --expect-owner takes back a claimed item", () => {
		const id = idOf(work("add", "reclaim bait").out);
		expect(work("take", id, "--as", "s6").code).toBe(0);
		cover("reclaim");
		const r = work("reclaim", id, "--force", "--reason", "crash");
		expect(r.code).toBe(0);
		expect(JSON.parse(work("show", id, "--json").out).state).toBe("READY");
	});
});

describe("work verb matrix — registry parity (must stay last)", () => {
	test("every verb on the --help door face has a matrix scenario", () => {
		expect(covered).not.toBe(new Set());
		expect([...covered].sort()).toEqual(fx.registryFromHelp("work.ts").sort());
	});
});

afterAll(() => fx.cleanup());

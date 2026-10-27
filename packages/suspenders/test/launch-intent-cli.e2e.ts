// launch-intent-cli.test.ts — W724: `dispatch intent inspect|fail` — the
// operator door for wedged lane_launch_intents. Covers: inspect verdicts
// (FAILED→dead, pid-less→unknown), fail guards (refuse absent, refuse thin
// evidence, idempotent on already-FAILED), the wedge fix (unknown + evidence
// → FAILED + evidence banked as a bus event), and the CLI door (exit codes).
import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	launchIntent,
	launchSchema,
	type LaunchIntent,
} from "../scripts/lib/launch-fencing.ts";
import {
	failIntent,
	intentMain,
	inspectIntents,
} from "../scripts/lib/launch-intent-cli.ts";
// W723: govdb pins REG_ROOT from HOME at module load — a static import
// resolves the LIVE machine store. Fixture HOME set BEFORE the cache-busted
// import (?home= idiom) keeps every openStore() on the fixture.

const dirs: string[] = [];
const HOME = mkdtempSync(join(tmpdir(), "fleet-intent-cli-home-"));
// restore at teardown: the rest of the suite shares this process — a leaked
// fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const { openStore, projectIdentity } = govdb;

test.afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test.afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

/** Fixture store: the module-scope ?home= import pinned REG to the fixture
 * HOME, so openStore() lands in the fixture, never the live machine store. */
function isolatedStore() {
	process.env.GOVERNOR_STORE_URL = "local";
	const store = openStore();
	expect(store.local).toBe(true);
	return store;
}

function seedIntent(
	store: Parameters<typeof launchIntent>[0],
	over: Partial<LaunchIntent> & { item: string },
	project = "p1",
): void {
	launchSchema(store);
	store.run(
		`INSERT OR REPLACE INTO lane_launch_intents (project,item,sid,nonce,revision,executor,host,attempt,state,pid,birth) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		project,
		over.item,
		over.sid ?? `auto-${over.item}`,
		over.nonce ?? "n1",
		over.revision ?? 1,
		over.executor ?? "/bin/true",
		over.host ?? "h",
		over.attempt ?? 1,
		over.state ?? "REGISTERED",
		over.pid ?? null,
		over.birth ?? null,
	);
}

test("inspect: pid-less rows read unknown, FAILED rows read dead", () => {
	const store = isolatedStore();
	seedIntent(store, { item: "W1", state: "REGISTERED", pid: null });
	seedIntent(store, { item: "W3", state: "FAILED", pid: 5 });
	const rows = inspectIntents(store, "p1");
	const byItem = new Map(rows.map((r) => [r.item, r.verdict]));
	expect(byItem.get("W1")).toBe("unknown");
	expect(byItem.get("W3")).toBe("dead");
});

test("fail: refuses absent and thin evidence; banks evidence as FAILED", () => {
	const store = isolatedStore();
	seedIntent(store, { item: "W1", state: "REGISTERED", pid: null });
	let out = failIntent(store, "p1", "W999", "lane died hours ago on 429");
	expect(out.ok).toBe(false);
	out = failIntent(store, "p1", "W1", "short");
	expect(out.ok).toBe(false);
	expect(out.line).toContain("evidence");
	out = failIntent(store, "p1", "W1", "lane died hours ago on 429 wall");
	expect(out.ok).toBe(true);
	const row = launchIntent(store, "p1", "W1");
	expect(row?.state).toBe("FAILED");
});

test("fail: idempotent on already-FAILED", () => {
	const store = isolatedStore();
	seedIntent(store, { item: "W1", state: "FAILED", pid: 5 });
	const out = failIntent(store, "p1", "W1", "lane died hours ago on 429 wall");
	expect(out.ok).toBe(true);
});

test("CLI door: exit codes + JSON listing against an isolated store", () => {
	const repo = mkdtempSync(join(tmpdir(), "fleet-intent-repo-"));
	dirs.push(repo);
	mkdirSync(join(repo, ".git"));
	const store = isolatedStore();
	const project = projectIdentity(repo);
	seedIntent(store, { item: "W9", state: "REGISTERED", pid: null }, project);
	expect(
		intentMain(["inspect", "--item", "W9", "--json"], { repo, store }),
	).toBe(0);
	expect(
		intentMain(
			["fail", "--item", "W9", "--evidence", "dead lane autow9, claim held"],
			{ repo, store },
		),
	).toBe(0);
	expect(launchIntent(store, project, "W9")?.state).toBe("FAILED");
});

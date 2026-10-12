// launch-intent-cli.test.ts — W724: `dispatch intent inspect|fail` — the
// operator door for wedged lane_launch_intents. Covers: inspect verdicts
// (FAILED→dead, pid-less→unknown), fail guards (refuse absent, refuse thin
// evidence, idempotent on already-FAILED), the wedge fix (unknown + evidence
// → FAILED + evidence banked as a bus event), and the CLI door (exit codes).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import { openStore } from "../hooks/lib/govdb.ts";

const dirs: string[] = [];
const saved = { home: "", url: "" };

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	if (saved.home) process.env.HOME = saved.home;
	if (saved.url) process.env.GOVERNOR_STORE_URL = saved.url;
});

/** Isolated store: HOME → temp dir so REG() (and openStore's in-process
 * binding) lands in the fixture, never the live machine store. */
function isolatedStore() {
	saved.home ||= process.env.HOME ?? "";
	saved.url ||= process.env.GOVERNOR_STORE_URL ?? "";
	const home = mkdtempSync(join(tmpdir(), "fleet-intent-cli-"));
	dirs.push(home);
	process.env.HOME = home;
	process.env.GOVERNOR_STORE_URL = "local";
	const store = openStore();
	expect(store.local).toBe(true);
	return store;
}

function seedIntent(
	store: Parameters<typeof launchIntent>[0],
	over: Partial<LaunchIntent> & { item: string },
): void {
	launchSchema(store);
	store.run(
		`INSERT OR REPLACE INTO lane_launch_intents (project,item,sid,nonce,revision,executor,host,attempt,state,pid,birth) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		"p1",
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
	seedIntent(store, { item: "W9", state: "REGISTERED", pid: null });
	const project = realpathSync(repo);
	store.run(
		"UPDATE lane_launch_intents SET project=? WHERE item='W9'",
		project,
	);
	expect(intentMain(["inspect", "--item", "W9", "--json"], { repo })).toBe(0);
	expect(
		intentMain(
			["fail", "--item", "W9", "--evidence", "dead lane autow9, claim held"],
			{ repo },
		),
	).toBe(0);
	expect(launchIntent(store, project, "W9")?.state).toBe("FAILED");
});

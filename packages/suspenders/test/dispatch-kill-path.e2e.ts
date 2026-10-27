// W831 kill-path double-check, end to end: `coord pause` takes the
// pause_requested path ONLY with proof of life (registry row + lane-liveness
// verdict). On miss it reports INTERRUPTED — the sticky terminal state — so a
// ghost running state converges instead of a PAUSE_REQUESTED hanging unacked
// forever. --force is the explicit operator override.
import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { laneGlyph } from "../hooks/lib/watch/frame.ts";

const directories: string[] = [];
test.afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const SID = "autow831kill";

const call = (root: string, ...args: string[]) =>
	Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../hooks/bin/coord.ts"), ...args],
		{
			cwd: root,
			env: { ...process.env, HOME: root, GOVERNOR_STORE_URL: "local" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);

function seedLane(root: string, sid = SID): void {
	mkdirSync(join(root, ".fleet"), { recursive: true });
	writeFileSync(
		join(root, ".fleet", "lanes.json"),
		JSON.stringify([{ sid, item: "W1", pid: 999999999, host: hostname() }]),
	);
}

const dbAt = (root: string) =>
	new Database(join(root, ".cache/claude-governor/governor.db"));

test("dead registry row → INTERRUPTED fact + lane.interrupted event, never pause_requested", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-kill-"));
	directories.push(root);
	seedLane(root);
	const out = call(root, "pause", SID, "--reason", "drill");
	expect(out.exitCode, out.stderr.toString()).toBe(0);
	expect(out.stdout.toString()).toContain("no live process; sticky terminal");
	const db = dbAt(root);
	const fact = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${SID}.state`) as { value: string } | null;
	expect(fact?.value).toBe("INTERRUPTED");
	const kinds = db
		.query("SELECT kind FROM events WHERE target = ? ORDER BY kind")
		.all(SID)
		.map((r) => r.kind);
	expect(kinds).toEqual(["lane.interrupted"]);
	db.close();
});

test("--force skips the liveness gate → pause_requested even for a dead row", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-kill-force-"));
	directories.push(root);
	seedLane(root);
	const out = call(root, "pause", SID, "--reason", "drill", "--force");
	expect(out.exitCode, out.stderr.toString()).toBe(0);
	expect(out.stdout.toString()).toContain("pause_requested");
	const db = dbAt(root);
	const fact = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${SID}.state`) as { value: string } | null;
	expect(fact?.value).toBe("PAUSE_REQUESTED");
	db.close();
});

test("no registry row → INTERRUPTED (fail-closed on unknown)", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-kill-ghost-"));
	directories.push(root);
	const out = call(root, "pause", "nobody", "--reason", "drill");
	expect(out.exitCode, out.stderr.toString()).toBe(0);
	expect(out.stdout.toString()).toContain("no live process; sticky terminal");
	const db = dbAt(root);
	const fact = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get("lane.nobody.state") as { value: string } | null;
	expect(fact?.value).toBe("INTERRUPTED");
	db.close();
});

test("laneGlyph renders INTERRUPTED as a red ×", () => {
	const [g, col] = laneGlyph("INTERRUPTED");
	expect(g).toBe("×");
	expect(col("x")).toContain("\x1b[31m");
});

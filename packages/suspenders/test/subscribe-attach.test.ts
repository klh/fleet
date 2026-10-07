// test/subscribe-attach.test.ts — W417.1: the shared subscribe attach is
// idempotent per sid (an anchored pgrep detects a live subscribe, re-attach
// is a no-op) and spawnClaude wires it at spawn level. Tests 1–3 use a
// stub coord CLI (a looping sh script named coord.ts); test 4 drives the
// real recipe end-to-end — the spawned subscribe self-exits via the W494
// transcript-staleness watch, and cleanup pkills the wtest- sids only
// (real lane sids never carry that prefix).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachSubscribe,
	subscribeLive,
} from "../hooks/lib/subscribe-attach.ts";

const dir = mkdtempSync(join(tmpdir(), "subscribe-attach-"));
const stubDir = join(dir, "bin");
mkdirSync(stubDir, { recursive: true });
const stub = join(stubDir, "coord.ts");
// bun runs the stub as TypeScript (shebangs are ignored), so it must be
// valid TS that simply stays alive.
writeFileSync(stub, "setInterval(() => {}, 1e6);\n");
chmodSync(stub, 0o700);

const liveCount = (sid: string): number =>
	Bun.spawnSync([
		"/usr/bin/pgrep",
		"-f",
		`coord[.]ts subscribe --as ${sid}$`,
	]).stdout.toString().trim().split("\n").filter(Boolean).length;

afterAll(() => {
	Bun.spawnSync(["/usr/bin/pkill", "-f", `coord[.]ts subscribe --as wtest-`]);
	rmSync(dir, { recursive: true, force: true });
});

test("attach spawns exactly one live subscribe per sid; re-attach is a no-op", async () => {
	const sid = `wtest-${Date.now()}`;
	expect(subscribeLive(sid)).toBe(false);
	expect(attachSubscribe(sid, { coord: stub })).toBe(true);
	const deadline = Date.now() + 3000;
	while (!subscribeLive(sid) && Date.now() < deadline) await Bun.sleep(20);
	expect(subscribeLive(sid)).toBe(true);
	// idempotent: a live subscribe for the sid is detected and left alone
	expect(attachSubscribe(sid, { coord: stub })).toBe(false);
	expect(liveCount(sid)).toBe(1);
});

test("no spawn when no coord CLI resolves at the given path", () => {
	const sid = `wtest-absent-${Date.now()}`;
	expect(attachSubscribe(sid, { coord: join(dir, "absent", "coord.ts") }))
		.toBe(false);
	expect(subscribeLive(sid)).toBe(false);
});

test("spawnClaude attaches the sid's subscribe at spawn level, idempotently", async () => {
	const { spawnClaude } = await import("../scripts/lib/lane.ts");
	const sid = `wtest-spawn-${Date.now()}`;
	const base = {
		bin: "/usr/bin/true",
		prompt: "test only",
		cwd: dir,
		logFile: join(dir, "lane.log"),
		env: { ...process.env },
		sid,
	};
	spawnClaude(base);
	const deadline = Date.now() + 3000;
	while (!subscribeLive(sid) && Date.now() < deadline) await Bun.sleep(20);
	expect(subscribeLive(sid)).toBe(true);
	// a second spawn for the same sid must not double-attach
	spawnClaude(base);
	expect(liveCount(sid)).toBe(1);
});

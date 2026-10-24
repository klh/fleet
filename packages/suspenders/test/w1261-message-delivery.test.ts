// test/w1261-message-delivery.test.ts — W1261 regressions: live coord
// message delivery to an ACTIVE lane (registry process identity — the
// evidence `work lanes` trusts), and per-statement event-id attribution
// (two directed messages to distinct lanes printed one id, #67715).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w1261-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-w1261-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const SERVER = join(import.meta.dir, "..", "hooks", "bin", "store-server.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// scrub lane identity — session-start's canonical-v1 guard refuses fixture
// sids when a dispatched lane's own SUSPENDERS_* env leaks in (W383)
const env: Record<string, string> = {
	...(process.env as Record<string, string>),
	HOME,
	NO_COLOR: "1",
};
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
writeFileSync(join(REPO, "README.md"), "seed\n");
Bun.spawnSync(["git", "-C", REPO, "add", "README.md"], {
	stdout: "ignore",
	stderr: "ignore",
});
Bun.spawnSync(["git", "-C", REPO, "commit", "-q", "-m", "init"], {
	stdout: "ignore",
	stderr: "ignore",
});

const gitCommon = (repo: string): string => {
	const r = Bun.spawnSync(
		["git", "-C", repo, "rev-parse", "--git-common-dir"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const dir = r.stdout.toString().trim();
	return dir ? resolve(repo, dir) : repo;
};

const PROJECT = gitCommon(REPO);

// W511: the direct-note kind rides split-string assembly
const DIRECT_KIND = ["NO", "TE"].join("");

function run(args: string[], extra: Record<string, string> = {}) {
	const p = Bun.spawnSync(["bun", BIN, ...args], {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

const now = (): number => Date.now();
const minutesAgo = (n: number): number => now() - n * 60_000;

function seedLaneSession(
	sid: string,
	opts: { parented: boolean; hbAgeMin: number },
): void {
	const db = new Database(DB);
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path, actor, tags) VALUES (?, ?, 'worker', ?, ?, ?, ?, 'RUNNING', '', NULL, 'dev:lane', ?)",
	).run(
		sid,
		PROJECT,
		opts.parented ? "lane-parent-00000000" : null,
		join(REPO, ".worktrees", "W1261"),
		minutesAgo(opts.hbAgeMin),
		minutesAgo(opts.hbAgeMin),
		JSON.stringify({ name: "w1261 lane" }),
	);
	db.close();
}

function lastDirectEvent(): { id: number; target: string; payload: string } {
	return new Database(DB, { readonly: true })
		.query(
			"SELECT id, target, payload FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
		)
		.get(DIRECT_KIND) as { id: number; target: string; payload: string };
}

function storedIdFor(body: string): number {
	const row = new Database(DB, { readonly: true })
		.query(
			"SELECT id FROM events WHERE kind = ? AND payload LIKE ? ORDER BY id DESC LIMIT 1",
		)
		.get(DIRECT_KIND, `%"${body}"%`) as { id: number } | undefined;
	return row?.id ?? -1;
}

// a live harness-args process anchored to the sid — the fixture shape
// subscribe-liveness uses; laneAlive reads this lane alive
function spawnHeldCli(sid: string): ReturnType<typeof Bun.spawn> {
	const script = join(HOME, "claude");
	writeFileSync(script, "setInterval(() => {}, 1000);");
	return Bun.spawn([process.execPath, script, sid], {
		stdout: "ignore",
		stderr: "ignore",
	});
}

function registerLane(sid: string, pid: number): void {
	mkdirSync(join(REPO, ".fleet"), { recursive: true });
	writeFileSync(
		join(REPO, ".fleet", "lanes.json"),
		JSON.stringify([{ sid, item: "W1261", pid }]),
	);
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// bootstrap the fixture store (migrations create governor.db) before any
// direct Database seeding — coord-addressing runs `kb stats` for the same
// reason
run(["targets"]);

describe("W1261 live message delivery", () => {
	test("a live lane mid-long-turn gets live delivery, not the resume-gap deferral", () => {
		const sid = "lane-activ-55555555";
		const child = spawnHeldCli(sid);
		try {
			registerLane(sid, child.pid);
			seedLaneSession(sid, { parented: true, hbAgeMin: 31 });
			const r = run(["message", sid, "owner correction mid-turn"]);
			expect(r.code).toBe(0);
			expect(r.out).toContain("message queued");
			expect(r.out).not.toContain("queued until it resumes");
			const row = lastDirectEvent();
			expect(row.target).toBe(sid);
			expect(row.payload).toContain("owner correction mid-turn");
		} finally {
			child.kill();
		}
	});

	test("a stale-hb parented lane with no live identity still defers", () => {
		const sid = "lane-defer-66666666";
		// no registry entry: identity false → transcript NULL → role worker —
		// the fix must not flip genuinely absent lanes into live delivery
		seedLaneSession(sid, { parented: true, hbAgeMin: 31 });
		const r = run(["message", sid, "update across resume gap"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("queued until it resumes");
		expect(lastDirectEvent().target).toBe(sid);
	});

	test("two directed messages to distinct lanes print their own stored event ids", () => {
		const first = run([
			"message",
			"lane-activ-55555555",
			"twin one body",
			"--as",
			"twin-caller",
		]);
		const second = run([
			"message",
			"lane-defer-66666666",
			"twin two body",
			"--as",
			"twin-caller",
		]);
		for (const r of [first, second]) {
			expect(r.code).toBe(0);
			expect(r.out).toContain("message queued");
		}
		const printed = [first, second].map((r) =>
			Number(/#(\d+)/.exec(r.out)?.[1]),
		);
		expect(printed[0]).toBeNumber();
		expect(printed[1]).toBeNumber();
		expect(printed[0]).not.toBe(printed[1]);
		expect(storedIdFor("twin one body")).toBe(printed[0]);
		expect(storedIdFor("twin two body")).toBe(printed[1]);
	});
});

// The #67715 misattribution rode the HTTP store binding: the old emit read
// last_insert_rowid() as a SECOND round trip on the server's one shared
// connection. Over GOVERNOR_STORE_URL each message must still print the id
// of its own row — verified under concurrent CLI racers.
let httpBase = "";
const httpProcs: ReturnType<typeof Bun.spawn>[] = [];

async function startHttpStore(): Promise<void> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = probe.port;
	probe.stop(true);
	const server = Bun.spawn(["bun", SERVER, "--port", String(port)], {
		env: { ...env },
		stdout: "ignore",
		stderr: "ignore",
	});
	httpProcs.push(server);
	httpBase = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${httpBase}/health`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
}

function seedHttpLane(sid: string): void {
	const db = new Database(DB);
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path, actor, tags) VALUES (?, ?, 'worker', NULL, ?, ?, ?, 'RUNNING', '', NULL, 'dev:lane', ?)",
	).run(
		sid,
		PROJECT,
		join(REPO, ".worktrees", "W1261"),
		now(),
		now(),
		JSON.stringify({ name: "w1261 http lane" }),
	);
	db.close();
}

async function cliOverHttp(
	args: string[],
): Promise<{ code: number | null; out: string }> {
	const p = Bun.spawn(["bun", BIN, ...args], {
		cwd: REPO,
		env: { ...env, GOVERNOR_STORE_URL: httpBase },
		stdout: "pipe",
		stderr: "pipe",
	});
	httpProcs.push(p);
	await p.exited;
	return { code: p.exitCode, out: await new Response(p.stdout).text() };
}

describe("W1261 event ids over the HTTP store binding", () => {
	beforeAll(startHttpStore);

	afterAll(() => {
		for (const p of httpProcs) p.kill();
	});

	test("concurrent messages to distinct lanes never share one printed id", async () => {
		seedHttpLane("lane-http-77777777");
		seedHttpLane("lane-http-88888888");
		const msg = (sid: string, body: string): string[] => [
			"message",
			sid,
			body,
			"--as",
			"http-caller",
		];
		const results = await Promise.all([
			cliOverHttp(msg("lane-http-77777777", "http twin one")),
			cliOverHttp(msg("lane-http-88888888", "http twin two")),
			cliOverHttp(msg("lane-http-77777777", "http twin three")),
			cliOverHttp(msg("lane-http-88888888", "http twin four")),
		]);
		for (const r of results) {
			expect(r.code).toBe(0);
			expect(r.out).toContain("message queued");
		}
		const printed = results.map((r) => Number(/#(\d+)/.exec(r.out)?.[1]));
		expect(new Set(printed).size).toBe(printed.length);
		expect(storedIdFor("http twin one")).toBe(printed[0]);
		expect(storedIdFor("http twin two")).toBe(printed[1]);
	});
});

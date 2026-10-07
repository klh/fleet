// test/session-enroll.test.ts — W422.17.1 interactive-session enrollment:
// the pure decision matrix, the 0600 file writers/readers (reuse window),
// and the real hook round-trip (session-start mints/reuses, session-end
// retires) against a stub buckle front. Patterns: lane-auth.test.ts +
// session-start-lane.test.ts.
import { describe, expect, test, afterAll } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	enrollSessionKey,
	laneKeyMetaPath,
	laneSettingsPath,
	LANE_KEY_TTL_S,
	SESSION_KEY_REUSE_SLACK_S,
	sessionEnrollDecision,
} from "../scripts/lib/lane-auth.ts";
import { enrollTopLevel, retireTopLevel } from "../hooks/lib/hook-scripts.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-enroll-"));
const BELT = join(HOME, "belt.env");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const START_HOOK = join(import.meta.dir, "..", "hooks", "session-start.ts");
const HOOK_DIR = join(import.meta.dir, "..", "hooks");
const REPOS: string[] = [];
writeFileSync(BELT, "BUCKLE_ADMIN_KEY=bksk_test_admin\n");

const mintLog: string[] = [];
const stubFront = Bun.serve({
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		if (u.pathname === "/status") return new Response("ok");
		if (u.pathname === "/v1/admin/keys" && req.method === "POST") {
			const b = (await req.json().catch(() => ({}))) as { name?: string };
			const kid = `kid_${mintLog.length + 1}`;
			mintLog.push(`${b.name ?? "?"}=${kid}`);
			return Response.json(
				{ key: `bksk_minted_${mintLog.length}`, key_id: kid },
				{ status: 201 },
			);
		}
		const rm = /^\/v1\/admin\/keys\/(.+)\/revoke$/.exec(u.pathname);
		if (rm) return Response.json({ revoked: rm[1] });
		return new Response("no", { status: 404 });
	},
});
// pin BEFORE any dynamic import: lane.ts reads SUSPENDERS_BUCKLE_FRONT at
// module load — without this the mint would hit the live buckle spoke
// (found live: six stray enroll-sess-* keys had to be revoked).
process.env.SUSPENDERS_BUCKLE_FRONT = `http://127.0.0.1:${stubFront.port}`;

const newRepo = (): string => {
	const dir = mkdtempSync(join(process.cwd(), ".tmp-enroll-repo-"));
	Bun.spawnSync(["git", "init", "-q", dir]);
	REPOS.push(dir);
	return dir;
};

const runHook = (hook: string, repo: string, sid: string, front: string) => {
	const payload = join(
		HOME,
		`payload-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(
		payload,
		JSON.stringify({ session_id: sid, source: "startup", cwd: repo }),
	);
	const env = {
		...process.env,
		HOME,
		SUSPENDERS_BUCKLE_FRONT: front,
		SUSPENDERS_BELT_ENV: BELT,
	};
	const p = Bun.spawnSync(["bun", hook], {
		cwd: repo,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString(), code: p.exitCode };
};

const setFact = (key: string, value: string): void => {
	const db = new Database(DB, { create: true });
	db.query(
		"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	).run(key, value, Date.now());
	db.close();
};

afterAll(() => {
	stubFront.stop(true);
	Bun.spawnSync([
		"/usr/bin/pkill",
		"-f",
		"coord[.]ts subscribe --as enroll-sess",
	]);
	for (const r of REPOS) rmSync(r, { recursive: true, force: true });
	rmSync(HOME, { recursive: true, force: true });
});

describe("sessionEnrollDecision", () => {
	const base = {
		sid: "enroll-sess-1",
		front: "http://127.0.0.1:4101",
		minted: null,
		hasAdmin: true,
		govMode: "strict" as const,
	};
	test("front up + minted → enrolled with the /w/<sid> note", () => {
		const d = sessionEnrollDecision({
			...base,
			frontUp: true,
			minted: { key: "bksk_k", keyId: "kid1" },
		});
		expect(d.mode).toBe("enrolled");
		if (d.mode === "enrolled") {
			expect(d.key).toBe("bksk_k");
			expect(d.keyId).toBe("kid1");
		}
		expect(d.note).toContain("/w/enroll-s");
		expect(d.note).toContain("ttl 86400s");
	});
	test("no admin key → belt-direct, mode-independent", () => {
		for (const govMode of ["strict", "solo"] as const) {
			const d = sessionEnrollDecision({
				...base,
				frontUp: true,
				hasAdmin: false,
				govMode,
			});
			expect(d.mode).toBe("belt-direct");
			expect(d.note).toContain("no BUCKLE_ADMIN_KEY");
		}
	});
	test("front down → belt-direct, loud per mode", () => {
		const strict = sessionEnrollDecision({ ...base, frontUp: false });
		expect(strict.note).toContain("unreachable");
		expect(strict.note).toContain("governance:strict");
		expect(strict.note).toContain("LANE DISPATCH STILL REFUSES");
		const solo = sessionEnrollDecision({
			...base,
			frontUp: false,
			govMode: "solo",
		});
		expect(solo.note).toContain("governance:solo");
		expect(solo.note).toContain("rides belt direct");
	});
	test("mint failed (front up) → belt-direct, mode-rendered tail", () => {
		const strict = sessionEnrollDecision({ ...base, frontUp: true });
		expect(strict.note).toContain("mint failed");
		expect(strict.note).toContain("governance:strict");
		expect(strict.note).toContain("LANE DISPATCH STILL REFUSES");
		const solo = sessionEnrollDecision({
			...base,
			frontUp: true,
			govMode: "solo",
		});
		expect(solo.note).toContain("governance:solo");
	});
});

describe("hook round-trip (real session-start / session-end)", () => {
	test("top-level session enrolls: mint + 0600 files + note, then reuses", async () => {
		const repo = newRepo();
		const sid = "enroll-sess-enroll-1";
		const front = `http://127.0.0.1:${stubFront.port}`;
		const before = mintLog.length;
		const note1 = await enrollTopLevel({
			hookDir: HOOK_DIR,
			sid,
			cwd: repo,
			govMode: "strict",
			probeFn: async () => front,
		});
		expect(note1).toContain("GOVERNANCE: enrolled");
		expect(mintLog.length).toBe(before + 1);
		const metaP = laneKeyMetaPath(join(repo, ".fleet"), sid);
		const setP = laneSettingsPath(join(repo, ".fleet"), sid);
		expect(existsSync(metaP)).toBe(true);
		expect(existsSync(setP)).toBe(true);
		expect(statSync(setP).mode & 0o777).toBe(0o600);
		const meta = JSON.parse(readFileSync(metaP, "utf8")) as { key_id: string };
		const kid = meta.key_id;
		expect(mintLog.at(-1)).toContain(kid);
		// bootstrap re-fire (resume/clear) reuses, never re-mints
		const note2 = await enrollTopLevel({
			hookDir: HOOK_DIR,
			sid,
			cwd: repo,
			govMode: "strict",
			probeFn: async () => front,
		});
		expect(note2).toContain("GOVERNANCE: enrolled");
		expect(mintLog.length).toBe(before + 1);
		// session-end retires: revoke + both 0600 files gone
		const revoked: string[] = [];
		await retireTopLevel({
			hookDir: HOOK_DIR,
			sid,
			cwd: repo,
			fetchFn: (async (url: string | URL) => {
				revoked.push(String(url));
				return new Response(JSON.stringify({ ok: true }));
			}) as unknown as typeof fetch,
		});
		expect(revoked.some((u) => u.includes(kid))).toBe(true);
		expect(existsSync(metaP)).toBe(false);
		expect(existsSync(setP)).toBe(false);
	});
});

describe("hook fallback (front down)", () => {
	test("strict folds belt-direct with the loud note, no files", () => {
		const repo = newRepo();
		const r = runHook(
			START_HOOK,
			repo,
			"enroll-sess-frontdown",
			"http://127.0.0.1:1",
		);
		expect(r.out).toContain("GOVERNANCE: belt-direct");
		expect(r.out).toContain("unreachable");
		expect(r.out).toContain("governance:strict");
		expect(
			existsSync(
				laneKeyMetaPath(join(repo, ".fleet"), "enroll-sess-frontdown"),
			),
		).toBe(false);
	});
});

describe("hook fallback (governance:solo)", () => {
	test("solo wording renders when the front is down", () => {
		setFact("fleet.governance", "solo");
		const repo = newRepo();
		const r = runHook(
			START_HOOK,
			repo,
			"enroll-sess-solo",
			"http://127.0.0.1:1",
		);
		expect(r.out).toContain("GOVERNANCE: belt-direct");
		expect(r.out).toContain("governance:solo");
		setFact("fleet.governance", "strict");
	});
});

describe("enrollSessionKey (in-lib, stubbed fetch)", () => {
	test("fresh mint writes 0600 files with the session env grammar", async () => {
		const fleet = mkdtempSync(join(tmpdir(), "w422171-fleet-"));
		let mints = 0;
		const stub = (async () => {
			mints++;
			return new Response(
				JSON.stringify({ key: `bksk_m${mints}`, key_id: `kid_${mints}` }),
				{ status: 201 },
			);
		}) as unknown as typeof fetch;
		const o = {
			fleet,
			sid: "enroll-sess-2",
			front: "http://stub",
			frontUp: true,
			govMode: "strict" as const,
			admin: "bksk_admin",
			fetchFn: stub,
		};
		const first = await enrollSessionKey(o);
		expect(first.mode).toBe("enrolled");
		const setP = laneSettingsPath(fleet, "enroll-sess-2");
		expect(statSync(setP).mode & 0o777).toBe(0o600);
		const settings = JSON.parse(readFileSync(setP, "utf8")) as {
			env: Record<string, string>;
		};
		expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://stub/w/enroll-sess-2");
		expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("bksk_m1");
		expect(settings.env.OPENAI_BASE_URL).toBe("http://stub/w/enroll-sess-2/v1");
		expect(settings.env).not.toHaveProperty("ANTHROPIC_MODEL");
		// reuse: no second mint, same key back — bootstrap re-fires are cheap
		const second = await enrollSessionKey(o);
		expect(second).toMatchObject({ mode: "enrolled", keyId: "kid_1" });
		expect((second as { key: string }).key).toBe("bksk_m1");
		expect(mints).toBe(1);
		// age the meta past the reuse window → re-mint
		const metaP = laneKeyMetaPath(fleet, "enroll-sess-2");
		const meta = JSON.parse(readFileSync(metaP, "utf8")) as {
			mintedAt: number;
		};
		meta.mintedAt =
			Date.now() - (LANE_KEY_TTL_S - SESSION_KEY_REUSE_SLACK_S + 60) * 1000;
		writeFileSync(metaP, JSON.stringify(meta));
		const third = await enrollSessionKey(o);
		expect(third).toMatchObject({ mode: "enrolled", keyId: "kid_2" });
		expect(mints).toBe(2);
		rmSync(fleet, { recursive: true, force: true });
	});
});

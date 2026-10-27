// test/decant-daily-cas.test.ts — W1212.2: the canonical fact seam driven for
// real (FAIL61346 B3/B4: "stub spawn manually lands facts — does not validate
// the real production store boundary"). A live store-server on loopback (the
// HTTP transport the canonical seam also rides), the runner's REAL coord
// children (no opts.spawn override), and the exact-CAS fence end-to-end:
// accepts a matching pin, refuses a stale pin with the row untouched, and the
// decision half never even fires at a human-setter row.
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	DAILY_CLAIM_STAMP,
	factSetArgs,
	readExistingClaims,
	runDaily,
	sessionEvidenceId,
	workEvidenceId,
} from "../hooks/lib/fleet-loop/decant-daily.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";

setDefaultTimeout(120_000); // spawn-heavy: store-server + one bun child per write

const home = mkdtempSync(join(tmpdir(), "decant-daily-cas-"));
const hooks = join(import.meta.dir, "..", "hooks");
const COORD = join(hooks, "bin", "coord.ts");
const RUNNER = join(hooks, "bin", "decant-daily.ts");
const SETTER = DAILY_CLAIM_STAMP.setter;
const NOW = Date.now();
const envSaved = {
	HOME: process.env.HOME,
	URL: process.env.GOVERNOR_STORE_URL,
};

let server: ReturnType<typeof Bun.spawn> | null = null;
let url = "";

beforeAll(async () => {
	const reserve = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = reserve.port;
	reserve.stop(true);
	url = `http://127.0.0.1:${port}`;
	server = Bun.spawn(
		["bun", join(hooks, "bin/store-server.ts"), "--port", String(port)],
		{
			env: { ...process.env, HOME: home },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) break;
		} catch {}
		if (i === 99) throw new Error("store server did not start");
		await Bun.sleep(50);
	}
	// the runner and its coord children inherit THIS process env — point the
	// whole seam at the fixture store over the HTTP wire
	process.env.HOME = home;
	process.env.GOVERNOR_STORE_URL = url;
});

afterAll(() => {
	server?.kill();
	process.env.HOME = envSaved.HOME;
	if (envSaved.URL === undefined) delete process.env.GOVERNOR_STORE_URL;
	else process.env.GOVERNOR_STORE_URL = envSaved.URL;
	rmSync(home, { recursive: true, force: true });
});

/** raw store RPC — schema/seed writes ride the same wire the children do. */
async function rpc(
	sql: string,
	params: unknown[],
): Promise<Record<string, unknown>> {
	const response = await fetch(`${url}/rpc`, {
		method: "POST",
		body: JSON.stringify({ mode: "run", sql, params }),
	});
	expect(response.ok).toBe(true);
	return (await response.json()) as Record<string, unknown>;
}

const runCli = (args: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(["bun", COORD, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		// Bun children inherit the START-time environ — pass the live env so
		// the child rides the fixture store (W1212.2 fixture catch)
		env: { ...process.env },
	});
	return {
		code: p.exitCode ?? 1,
		out: `${new TextDecoder().decode(p.stdout)}${new TextDecoder().decode(p.stderr)}`,
	};
};

const factGet = (key: string): string => runCli(["fact", "get", key]).out;

/** fixture decant CLI: `sync -q` ok; `ls --json` returns one fresh session. */
function writeDecantStub(dir: string): string {
	const bin = join(dir, "decant-stub.ts");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "sync") process.exit(0);
if (a[0] === "ls") {
  const rows = [{ source_session_id: "s1", tool: "claude", model: "glm",
    started_at: new Date(${NOW} - 60000).toISOString(),
    ended_at: new Date(${NOW} - 30000).toISOString(),
    message_count: 4, total_input_tokens: 10, total_output_tokens: 20 }];
  process.stdout.write(JSON.stringify(rows));
}
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

const dir = join(home, "run");
mkdirSync(dir, { recursive: true });
const stubBin = writeDecantStub(dir);
// W1212.1: work evidence is project-scoped and host-stamped — seed rows
// under the project the runner (and its bin face, cwd=dir) resolves
const PROJ = projectIdentity(dir);
const HOST = hostname();
// the store child pins REG to $HOME/.cache/claude-governor (govdb-util
// REG_ROOT) — THIS is the db the seam reads and writes
const DB = join(home, ".cache", "claude-governor", "governor.db");

const dailyOpts = () => ({
	dbPath: DB, // the store-server's own file
	statePath: join(home, "decant-daily-state.json"),
	decantBin: stubBin,
	cwd: dir,
	windowMs: 24 * 3600_000,
	now: () => NOW,
	project: PROJ,
	host: HOST,
	// NO spawn override — defaultFactSpawn fires the REAL coord children
});

const workKeyOf = (id: string): string =>
	Object.keys(readExistingClaims(DB)).find((k) =>
		readExistingClaims(DB)[k]?.value?.includes(`work item ${id}`),
	) ?? "";

describe("real canonical seam (W1212.2 HTTP fixture)", () => {
	test("first pass lands claims via REAL coord children over the HTTP store", async () => {
		await rpc(
			"INSERT INTO work_items (project, id, title, state, result_sha, updated_at, created_at) VALUES (?, 'W1', 'done work item W1', 'DONE', 'sha-W1', ?, ?)",
			[PROJ, NOW - 60_000, NOW - 60_000],
		);
		const r = await runDaily(dailyOpts());
		expect(r.ok).toBe(true);
		expect(r.created.length).toBe(2); // work:W1 + session:s1
		expect(r.deduped).toEqual([]);
		expect(r.stale).toEqual([]);
		// the row is REAL: version 1, mechanical stamp, evidence id
		const out = factGet(workKeyOf("W1"));
		expect(out).toContain("(v1)");
		expect(out).toContain(SETTER);
		expect(out).toContain(`ev ${workEvidenceId(PROJ, HOST, "W1")}`);
	});

	test("human edit between read and write survives; stale pins refused, row untouched", async () => {
		// a human replaces the SESSION claim: no CAS (deliberate — humans
		// don't pin), version bumps 1→2, the setter leaves the mechanical
		// stamp; the WORK row stays mechanical for the accept test below
		const sessKey =
			Object.keys(readExistingClaims(DB)).find((k) =>
				readExistingClaims(DB)[k]?.value?.startsWith("session claude"),
			) ?? "";
		const h = runCli([
			"fact",
			"set",
			sessKey,
			"--text",
			"human correction",
			"--confidence",
			"0.7",
			"--setter",
			"human",
			"--evidence",
			"review",
		]);
		expect(h.code).toBe(0);
		expect(readExistingClaims(DB)[sessKey]?.version).toBe(2);
		// the decision half: a human-setter row dedupes — zero children fire
		const r = await runDaily(dailyOpts());
		// W1212.1 cursor: W1 sits behind the cursor — only the re-listed
		// (human-edited) session claim is re-decided, and it dedupes
		expect(r.deduped.length).toBe(1);
		expect(r.created).toEqual([]);
		expect(r.reclaimed).toEqual([]);
		expect(r.tombstoned).toEqual([]);
		expect(r.ok).toBe(true);
		// the fence itself: the runner's OWN argv shapes, pinned STALE at v1,
		// refused by the real store — human value survives byte-for-byte
		for (const mode of ["reclaim", "tombstone"] as const) {
			const stale = runCli(
				factSetArgs(
					sessKey,
					"mechanical overwrite",
					sessionEvidenceId(HOST, "s1"),
					mode,
					1,
				),
			);
			expect(stale.code).toBe(2);
			expect(stale.out).toContain("refused");
			expect(stale.out).toContain("current version 2");
		}
		expect(factGet(sessKey)).toContain("human correction");
		expect(factGet(sessKey)).toContain("(v2)");
	});

	test("exact-pin reclaim and tombstone ACCEPT through the real store when versions match", async () => {
		// the runner's own tombstone argv retracts the WORK claim store-side
		// (pinned at the version read) — evidence still presents → the next
		// pass RECLAIMS it, pinned at the version read after the retraction
		const key = workKeyOf("W1");
		const cur = readExistingClaims(DB)[key];
		const re = runCli(
			factSetArgs(
				key,
				cur?.value ?? "",
				workEvidenceId(PROJ, HOST, "W1"),
				"tombstone",
				cur?.version ?? 0,
			),
		);
		expect(re.code).toBe(0);
		const before = readExistingClaims(DB)[key];
		expect(before?.verdict).toBe("retracted");
		expect(before?.version).toBe(2);
		// W1212.1 cursor: drop the state stamp so the pass re-collects W1 —
		// the reclaim needs its evidence back in view
		rmSync(dailyOpts().statePath, { force: true });
		const r = await runDaily(dailyOpts());
		expect(r.ok).toBe(true);
		expect(r.reclaimed).toEqual([key]);
		expect(readExistingClaims(DB)[key]?.verdict).toBe("fresh");
		expect(readExistingClaims(DB)[key]?.version).toBe(3);
		// tombstone accept: evidence vanishes → the pass retracts, pinned at
		// the version the reclaim left
		await rpc("DELETE FROM work_items WHERE id = 'W1'", []);
		const r2 = await runDaily(dailyOpts());
		expect(r2.ok).toBe(true);
		expect(r2.tombstoned).toEqual([key]);
		const w = readExistingClaims(DB)[key];
		expect(w?.verdict).toBe("retracted");
		expect(w?.setter).toBe(SETTER);
		expect(w?.version).toBe(4); // v1 create → v2 retract → v3 reclaim → v4
	});

	test("the real runner face (bin, --json) rides the same seam and exits 0", async () => {
		await rpc(
			"INSERT INTO work_items (project, id, title, state, result_sha, updated_at, created_at) VALUES (?, 'W2', 'done work item W2', 'DONE', 'sha-W2', ?, ?)",
			[PROJ, NOW - 30_000, NOW - 30_000],
		);
		const p = Bun.spawnSync(["bun", RUNNER, "--json", "--window-hours", "24"], {
			stdout: "pipe",
			stderr: "pipe",
			cwd: dir,
			env: { ...process.env }, // live env: fixture HOME + store redirect
		});
		expect(p.exitCode).toBe(0);
		const result = JSON.parse(new TextDecoder().decode(p.stdout)) as {
			ok: boolean;
			created: string[];
			stale: string[];
			errors: string[];
		};
		expect(result.ok).toBe(true);
		expect(result.created.length).toBe(1); // work:W2 (session:s1 dedupes)
		expect(result.stale).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(readExistingClaims(DB)[workKeyOf("W2")]?.version).toBe(1);
	});
});

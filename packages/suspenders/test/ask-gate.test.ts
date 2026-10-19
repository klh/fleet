// test/ask-gate.test.ts — W817 ask-in-session wiring (the real gate spawn,
// real coord CLI, fixture store — sweep.test.ts recipe): owner meta-questions
// detected by shape+vocab screens, lesson/fact lookup first, kev-class triage
// (self vs coordinator, 5s cap, deterministic fallback when kev is
// unreachable), routing via `coord consult <coordinator-sid>` with OPEN-consult
// dedup. Advisory law: silent allow everywhere else. Includes the komfur W1
// double-mint worked example end-to-end (route + supersede playbook).
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-ask-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-ask-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const gate = join(import.meta.dir, "..", "hooks", "gate.ts");
const work = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// projectIdentity() mirror — git walks UP through a scaffolded .git, so the
// identity is the PARENT repo's .git (sweep.test.ts note)
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
const SID = "ask-lane-aaaaaaaa0001";
const COORD = "ask-coord-bbbbbbbb0002";

function run(args: string[], cwd = REPO) {
	const p = Bun.spawnSync(["bun", ...args], {
		cwd,
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

/** Spawn the real gate entrypoint with a UserPromptSubmit payload
 *  (temp-file stdin — Bun spawnSync drops `input`). */
function askGate(
	prompt: string,
	over: Record<string, string> = {},
): {
	code: number;
	out: string;
	json: { hookSpecificOutput?: { additionalContext?: string } } | null;
} {
	const pf = join(
		HOME,
		`ask-payload-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(
		pf,
		JSON.stringify({
			session_id: SID,
			prompt,
			cwd: REPO,
			transcript_path: "",
		}),
	);
	const p = Bun.spawnSync(["bun", gate, "ask"], {
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
		// SUSPENDERS_SID wins laneIdFor's resolution — pin it to the payload
		// sid so the ambient lane env can't re-attribute the ask
		env: { ...env, SUSPENDERS_SID: SID, ...over },
	});
	const out = p.stdout.toString();
	return { code: p.exitCode, out, json: parseHookJson(out) };
}

function parseHookJson(out: string) {
	try {
		return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
			hookSpecificOutput?: { additionalContext?: string };
		} | null;
	} catch {
		return null;
	}
}

function consultRows(
	where = "",
): { id: number; state: string; expert_sid: string; question: string }[] {
	const db = new Database(DB, { readonly: true });
	const rows = db
		.query(`SELECT id, state, expert_sid, question FROM consults ${where}`)
		.all() as {
		id: number;
		state: string;
		expert_sid: string;
		question: string;
	}[];
	db.close();
	return rows;
}

// ---- seeds ----
function seedSession(sid: string, role = "worker"): void {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, ?, ?, ?, 'RUNNING')",
	).run(sid, PROJ, role, Date.now(), Date.now());
	db.close();
}
function seedFact(key: string, value: string): void {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, ts) VALUES (?, ?, ?)",
	).run(key, value, Date.now());
	db.close();
}
// bootstrap migrates the db (work tables incl.) so seeds + work CLI run
run([coord, "bootstrap", "--as", SID]);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const DEAD_KEV = { SUSPENDERS_KEV_URL: "http://127.0.0.1:1" };
const Q_KOMFUR = "why are there two W1 rows in the komfur graph?";

describe("ask-gate screens (pure + spawned)", () => {
	test("classifier: komfur W1 question is question-shaped with a W-id signal", async () => {
		const { isQuestionShaped, fleetMetaHits, fallbackVerdict } = await import(
			"../hooks/gates/ask.ts"
		);
		expect(isQuestionShaped(Q_KOMFUR)).toBe(true);
		expect(fleetMetaHits(Q_KOMFUR)).toContain("work-item id");
		expect(fallbackVerdict(["work-item id"])).toBe("coord");
		expect(fallbackVerdict(["lane"])).toBeNull();
		expect(fallbackVerdict(["lane", "board"])).toBe("coord");
	});

	test("non-meta question stays silent", () => {
		const r = askGate("why did my test fail?", DEAD_KEV);
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("{}");
	});

	test("fleet-vocab directive (not a question) stays silent", () => {
		const r = askGate("dispatch two more lanes for the w817 item", DEAD_KEV);
		expect(r.out.trim()).toBe("{}");
	});

	test("kill switch SUSPENDERS_ASK=0", () => {
		const r = askGate(Q_KOMFUR, { ...DEAD_KEV, SUSPENDERS_ASK: "0" });
		expect(r.out.trim()).toBe("{}");
	});

	test("no live coordinator: silent, no consult", () => {
		const r = askGate(Q_KOMFUR, DEAD_KEV);
		expect(r.out.trim()).toBe("{}");
		expect(consultRows()).toHaveLength(0);
	});
});

describe("ask-gate routing (coordinator seeded)", () => {
	// seeds run in beforeAll (NOT describe-body): the screens describe's
	// "no live coordinator" test must see an unseeded store
	beforeAll(() => {
		seedSession(COORD, "coordinator");
		seedFact("coordinator.sid", COORD);
	});

	test("komfur W1 worked example: kev down + W-id falls back to routing", () => {
		const r = askGate(Q_KOMFUR, DEAD_KEV);
		expect(r.code).toBe(0);
		const rows = consultRows(`WHERE asker_sid = '${SID}' AND state = 'OPEN'`);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.expert_sid).toBe(COORD);
		expect(rows[0]?.question).toBe(Q_KOMFUR);
		expect(r.json?.hookSpecificOutput?.additionalContext).toContain(
			"[fleet-ask] routed to the coordinator as C",
		);
	});

	test("dedup: same question re-asked re-injects the pointer, never a second row", () => {
		const r = askGate(Q_KOMFUR, DEAD_KEV);
		expect(r.code).toBe(0);
		const rows = consultRows(`WHERE asker_sid = '${SID}' AND state = 'OPEN'`);
		expect(rows).toHaveLength(1);
		expect(r.json?.hookSpecificOutput?.additionalContext).toContain(
			"already routed as C",
		);
	});

	test("the owning session closes the younger duplicate per triage (supersede playbook)", () => {
		// two rows for one logical task = the double-mint; triage keeps the
		// canonical row and supersedes the younger
		const a = run([work, "add", "komfur graph double-mint (canonical)"]);
		const b = run([
			work,
			"add",
			"komfur graph double-mint (younger duplicate)",
		]);
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);
		const s = run([work, "supersede", "W2", "--by", "W1"]);
		expect(s.code).toBe(0);
		const db = new Database(DB, { readonly: true });
		const st = db.query("SELECT state FROM work_items WHERE id = 'W2'").get() as
			| { state: string }
			| undefined;
		db.close();
		expect(st?.state).toBe("SUPERSEDED");
	});
});

describe("ask-gate kev triage", () => {
	test("kev verdict self: lesson pointer injected, no consult", async () => {
		seedFact(
			"lesson.ask-test",
			"ask-lane self-answerable lessons answer meta questions without routing",
		);
		const srv = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					JSON.stringify({
						model: "kev-test",
						answers: {
							d: {
								type: "choice",
								choice: "self",
								confidence: 0.9,
								probabilities: { self: 0.9, coord: 0.1 },
							},
						},
						usage: { input_tokens: 10, output_tokens: 2 },
						latency_ms: 1,
					}),
					{ headers: { "content-type": "application/json" } },
				),
		});
		try {
			// async spawn — an in-process serve stub cannot answer spawnSync
			// (W362 precedent); SUSPENDERS_SID wins the laneId race over env
			const proc = Bun.spawn(["bun", gate, "ask"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME,
					SUSPENDERS_SID: SID,
					SUSPENDERS_KEV_URL: `http://127.0.0.1:${srv.port}`,
				},
			});
			proc.stdin.write(
				JSON.stringify({
					session_id: SID,
					prompt: "are lanes self-answerable for meta questions?",
					cwd: REPO,
					transcript_path: "",
				}),
			);
			proc.stdin.end();
			await proc.exited;
			const out = await new Response(proc.stdout).text();
			expect(out).toContain("self-answerable");
			expect(consultRows()).toHaveLength(1); // only the worked-example row
		} finally {
			srv.stop(true);
		}
	});
});

describe("ask-gate answer delivery (W861)", () => {
	test("coordinator leg: the routed consult left a consult event targeted at the coordinator", () => {
		const db = new Database(DB, { readonly: true });
		const ev = db
			.query("SELECT id FROM events WHERE kind = 'consult' AND target = ?")
			.get(COORD);
		db.close();
		expect(ev).toBeDefined();
	});

	test("consult reply surfaces in the asking session on the next prompt", () => {
		const open = consultRows(`WHERE asker_sid = '${SID}' AND state = 'OPEN'`);
		expect(open).toHaveLength(1);
		const cid = `C${open[0]?.id}`;
		const r = run([
			coord,
			"consult-reply",
			cid,
			"komfur: the second W1 is the archive copy",
			"--as",
			COORD,
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("ANSWERED");
		const a = askGate("hello");
		expect(a.code).toBe(0);
		const ctx = a.json?.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain("coord-inbox:");
		expect(ctx).toContain("komfur: the second W1 is the archive copy");
		// cursor advanced — the same answer never re-delivers
		const b = askGate("hello again");
		expect(b.out.trim()).toBe("{}");
	});

	test("a declined consult also surfaces (no silent dead end)", () => {
		const q =
			"why is the board not showing the worktree dispatch lanes and W9 rows?";
		const routed = askGate(q);
		const ctx0 = routed.json?.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx0).toContain("[fleet-ask] routed to the coordinator as C");
		const m = ctx0.match(/as C(\d+)/);
		const cid = `C${m?.[1]}`;
		const d = run([coord, "consult-reply", cid, "--decline", "--as", COORD]);
		expect(d.code).toBe(0);
		expect(d.out).toContain("DECLINED");
		const a = askGate("hello");
		const ctx = a.json?.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain(`coord-inbox:`);
		expect(ctx).toContain(cid);
	});
});

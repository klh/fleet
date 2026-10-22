// steer.test.ts — W1035: the steer kit. Pure lib units (lanePhase, ackFor,
// the kev decider's overrides + fallbacks) plus the coord steer verb's gate
// surface against a fixture store (child spawns, coord-addressing pattern).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	ackFor,
	decideSteerOrRedo,
	lanePhase,
	logReadOf,
	steerStateDoc,
	STEER_WINDOW_MS,
} from "../hooks/lib/steer-decision.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-steer-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-steer-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

const env: Record<string, string> = {
	...(process.env as Record<string, string>),
	HOME,
	NO_COLOR: "1",
	// deterministic kev + scrub: no live :8912, no operator denylist in a test
	SUSPENDERS_KEV_URL: "http://127.0.0.1:9",
	SUSPENDERS_SCRUB_DENYLIST: "0",
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

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", BIN, ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const gitDir = r.exitCode === 0 ? r.stdout.toString().trim() : "";
	return gitDir ? resolve(dir, gitDir) : dir;
}

const PROJECT = projectOf(REPO);
const LIVE_SID = "lane-steer-live-11111111";

beforeAll(() => {
	run(["kb", "stats"]); // initializes the fixture store
	const db = new Database(DB);
	const now = Date.now();
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path, actor, tags) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)",
	).run(
		LIVE_SID,
		PROJECT,
		"worker",
		null,
		join(REPO, ".worktrees", "W1035"),
		now,
		now,
		"shell,fs,git",
		null,
		"dev:steer",
		JSON.stringify({}),
	);
	db.close();
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("lanePhase", () => {
	test("assistant tool_use frame reads mid-tool", () => {
		const tail = `${JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Bash" }] },
		})}\n`;
		expect(lanePhase(tail)).toBe("tool");
	});
	test("result frame reads idle, non-JSON log reads unknown", () => {
		expect(lanePhase('{"type":"result","subtype":"success"}\n')).toBe("idle");
		expect(lanePhase("starting lane...\n")).toBe("unknown");
		expect(lanePhase("")).toBe("unknown");
	});
	test("generating: assistant text and user frames", () => {
		expect(
			lanePhase(
				'{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n',
			),
		).toBe("generating");
		expect(lanePhase('{"type":"user","message":{"content":[]}}\n')).toBe(
			"generating",
		);
	});
});

describe("ackFor", () => {
	test("dead and unknown probes never fake a queue", () => {
		expect(ackFor("dead", "generating")).toBe("failed");
		expect(ackFor("unknown", "idle")).toBe("failed");
	});
	test("mid-tool is pending, otherwise accepted", () => {
		expect(ackFor("alive", "tool")).toBe("pending");
		expect(ackFor("alive", "idle")).toBe("accepted");
		expect(ackFor("alive", "unknown")).toBe("accepted");
	});
});

describe("decideSteerOrRedo", () => {
	const base = {
		item: {
			id: "W1",
			title: "t",
			state: "CLAIMED",
			description: null,
			attempt: 1,
		},
		lane: {
			verdict: "alive" as const,
			phase: "generating" as const,
			logAgeMs: 30_000,
		},
		spend: {
			fresh: 500_000,
			cached: 100_000,
			out: 40_000,
			agentMs: 30 * 60_000,
		},
	};

	test("dead probe and FAILED item are deterministic redo overrides", async () => {
		let kevCalls = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			kevCalls++;
			throw new Error("kev must not be consulted");
		}) as typeof fetch;
		try {
			const dead = await decideSteerOrRedo({
				...base,
				lane: { ...base.lane, verdict: "dead" },
			});
			expect(dead.choice).toBe("redo");
			expect(dead.via).toBe("override");
			const failed = await decideSteerOrRedo({
				...base,
				item: { ...base.item, state: "FAILED" },
			});
			expect(failed.choice).toBe("redo");
			expect(failed.via).toBe("override");
			expect(kevCalls).toBe(0);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("kev unavailable reads let-ride, never a redo", async () => {
		const d = await decideSteerOrRedo(base, { timeoutMs: 250 });
		expect(d.choice).toBe("let-ride");
		expect(d.via).toBe("kev-unavailable");
	});

	test("kev breaks the fuzzy case", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url, _init) => {
			return new Response(
				JSON.stringify({
					model: "kev-test",
					answers: {
						d: {
							type: "choice",
							choice: "steer",
							confidence: 0.61,
							probabilities: { steer: 0.61, redo: 0.24, "let-ride": 0.15 },
						},
					},
					usage: { input_tokens: 70, output_tokens: 8 },
					latency_ms: 12,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const d = await decideSteerOrRedo(base);
			expect(d.choice).toBe("steer");
			expect(d.via).toBe("kev");
			expect(d.confidence).toBeCloseTo(0.61);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("steerStateDoc", () => {
	test("carries item shape, out/min and posture", () => {
		const doc = steerStateDoc({
			item: {
				id: "W42",
				title: "Fix the gate",
				state: "CLAIMED",
				description: "d",
				attempt: 2,
			},
			lane: { verdict: "alive", phase: "tool", logAgeMs: 120_000 },
			spend: {
				fresh: 1_000_000,
				cached: 500_000,
				out: 60_000,
				agentMs: 30 * 60_000,
			},
		});
		expect(doc).toContain("W42");
		expect(doc).toContain("Fix the gate");
		expect(doc).toContain("~2000 out/min");
		expect(doc).toContain("probe alive");
	});
	test("STEER_WINDOW_MS is the one-steer-per-hour gate", () => {
		expect(STEER_WINDOW_MS).toBe(3_600_000);
	});
});

describe("coord steer verb surface", () => {
	test("bare steer dies with the usage line", () => {
		const r = run(["steer"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("usage: steer");
	});

	test("an unresolvable needle dies at target resolution", () => {
		const r = run(["steer", "no-such-lane-sid", "hello"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("no live session target");
	});

	test("the .fleet/steer-paused kill switch refuses before any emit", () => {
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(join(REPO, ".fleet", "steer-paused"), "paused\n");
		try {
			const r = run(["steer", LIVE_SID, "hello"]);
			expect(r.err).toContain("steering paused");
			const db = new Database(DB, { readonly: true });
			const rows = db
				.query("SELECT id FROM events WHERE target = ?")
				.all(LIVE_SID);
			db.close();
			expect(rows.length).toBe(0);
		} finally {
			rmSync(join(REPO, ".fleet", "steer-paused"), { force: true });
		}
	});

	test("secret-bearing input trips the scrub gate", () => {
		// fake key material — the steer secrets gate must refuse it
		const r = run(["steer", LIVE_SID, "token sk-test-abcdef1234567890abcd"]); // scrub:allow
		expect(r.err).toContain("steer refused");
	});

	test("logReadOf reads the lane log phase and fails open", () => {
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		expect(logReadOf(REPO, "missing-123")).toEqual({
			phase: "unknown",
			ageMs: null,
		});
		writeFileSync(
			join(REPO, ".fleet", "lane-missing-123.log"),
			`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } })}\n`,
		);
		const read = logReadOf(REPO, "missing-123");
		expect(read.phase).toBe("tool");
		expect(typeof read.ageMs).toBe("number");
		expect(existsSync(join(REPO, ".fleet", "lane-missing-123.log"))).toBe(true);
	});
});

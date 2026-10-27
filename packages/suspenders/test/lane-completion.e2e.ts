import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemCapsuleKey } from "../hooks/lib/capsule-fence.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const root = mkdtempSync(join(tmpdir(), "fleet-completion-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
// W670: an ambient KLH_CLAIM_TOKEN (this test runner's own dispatch lane)
// leaks into fixture children through the process.env spread — done prefers
// the env channel over the lane-context file, so every terminal write would
// present the runner's token and read as a stale writer. The fixture's
// token channel is .fleet/lane-context.json (dispatch's durable channel).
delete env.KLH_CLAIM_TOKEN;
const source = join(import.meta.dir, "../hooks");
test.afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

function command(cwd: string, args: string[], input?: unknown) {
	const payload = join(root, "input.json");
	writeFileSync(payload, JSON.stringify(input ?? {}));
	const p = Bun.spawnSync(args, {
		cwd,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
function fixture(priority?: number) {
	const cwd = join(root, `repo-${++sequence}`);
	mkdirSync(cwd);
	const git = (...args: string[]) => command(cwd, ["git", ...args]);
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(cwd, "README.md"), "base\n");
	git("add", "README.md");
	git("commit", "-qm", "base");
	const work = (...args: string[]) =>
		command(cwd, [process.execPath, join(source, "bin/work.ts"), ...args]);
	const priorityFlag =
		priority === undefined ? [] : ["--priority", String(priority)];
	const id =
		work("add", "completion test", ...priorityFlag).out.match(/W\d+/)?.[0] ??
		"";
	const takeOut = work("take", id, "--as", "dispatch-owner");
	expect(takeOut.code).toBe(0);
	mkdirSync(join(cwd, ".fleet"));
	writeFileSync(join(cwd, ".klh-brief.md"), "generated mission");
	writeFileSync(
		join(cwd, ".fleet/lane-context.json"),
		JSON.stringify({
			sid: "dispatch-owner",
			item: id,
			baseline: git("rev-parse", "HEAD").out.trim(),
			launchedAt: 123,
			// W643: the take-minted claim token rides the durable context channel
			claimToken: /claim token: ([0-9a-f]{48})/.exec(takeOut.out)?.[1],
		}),
	);
	let nativeTurn = 0;
	const transcript = join(cwd, ".fleet/native-transcript.jsonl");
	// W1124.13: every intended-new turn emits a normalized native assistant row
	// (real native row shape, synthetic identity/times) so each stop consumes
	// the budget exactly as before; stopSame replays the same assistant turn.
	const nativeTranscript = (): string => {
		nativeTurn++;
		writeFileSync(
			transcript,
			`${JSON.stringify({
				type: "assistant",
				uuid: `fixture-block-${nativeTurn}`,
				parentUuid: "fixture-parent",
				timestamp: new Date().toISOString(),
				message: {
					id: `fixture-message-${nativeTurn}`,
					role: "assistant",
					stop_reason: "tool_use",
					content: [
						{ type: "tool_use", id: "fixture-tool", name: "Edit", input: {} },
					],
				},
			})}\n`,
		);
		return transcript;
	};
	const stopSame = () =>
		command(cwd, [process.execPath, join(source, "gate.ts"), "stop"], {
			cwd,
			session_id: "harness-uuid-different-from-owner",
			stop_hook_active: true,
			transcript_path: transcript,
		});
	const stop = (message?: string) =>
		command(cwd, [process.execPath, join(source, "gate.ts"), "stop"], {
			cwd,
			session_id: "harness-uuid-different-from-owner",
			stop_hook_active: true,
			last_assistant_message: message,
			transcript_path: nativeTranscript(),
		});
	const stopFresh = (message?: string) =>
		command(cwd, [process.execPath, join(source, "gate.ts"), "stop"], {
			cwd,
			session_id: "harness-uuid-different-from-owner",
			stop_hook_active: false,
			last_assistant_message: message,
			transcript_path: nativeTranscript(),
		});
	const coord = (...args: string[]) =>
		command(cwd, [process.execPath, join(source, "bin/coord.ts"), ...args]);
	return { cwd, git, work, id, stop, stopFresh, stopSame, coord };
}

test("direct messages take priority without spending the lane continuation budget", () => {
	const f = fixture();
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		// the directed_event_receipt_ai trigger queues the receipt with the
		// event insert — assert the real queued path, never a second manual row
		const inserted = db
			.query(
				"INSERT INTO events (ts, source, kind, payload, target) VALUES (?, 'owner', 'NOTE', ?, 'dispatch-owner')",
			)
			.run(
				Date.now(),
				JSON.stringify({ note: "Read this before continuing the work item" }),
			);
		expect(
			db
				.query(
					"SELECT state FROM direct_message_receipts WHERE event_id = ? AND sid = 'dispatch-owner'",
				)
				.get(inserted.lastInsertRowid),
		).toEqual({ state: "QUEUED" });
		const result = f.stop();
		expect(result.err).toContain("TURN-BOUNDARY INBOX");
		expect(result.err).toContain("Read this before continuing the work item");
		expect(result.err).not.toContain("Re-ask");
		db.query(
			"UPDATE direct_message_receipts SET state = 'ACCEPTED' WHERE event_id = ?",
		).run(inserted.lastInsertRowid);
		expect(f.stop().err).toContain("Re-ask 1/3");
	} finally {
		db.close();
	}
});

test("empty lane cannot bypass stop checks; budget exhaustion records FAILED", () => {
	const f = fixture();
	// priority 0 → class light → continuation budget 3
	for (let attempt = 1; attempt <= 3; attempt++) {
		const result = f.stop();
		expect(result.err + result.out).toContain(`Re-ask ${attempt}/3`);
	}
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("documentation edits and commits remain progress until verified work done", () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "README.md"), "meaningful change\n");
	expect(f.stop().err).toContain("STOP-GATE");
	f.git("add", "README.md");
	f.git("commit", "-qm", "delivered docs");
	expect(f.stop().err).toContain("STOP-GATE");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
	const sha = f.git("rev-parse", "HEAD").out.trim();
	expect(
		f.work(
			"done",
			f.id,
			"--sha",
			sha,
			"--summary",
			"Updated the documentation to test.describe the delivered behavior and verified its completion evidence.",
		).code,
	).toBe(0);
	expect(f.stop().code).toBe(0);
});

test("explicit blocked reason records incomplete work, never success", () => {
	const f = fixture();
	expect(f.stop(`BLOCKED ${f.id}: upstream service is unavailable`).code).toBe(
		0,
	);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("a different graph owner is not controlled by this lane", () => {
	const f = fixture();
	f.work("release", f.id, "--as", "dispatch-owner");
	f.work("take", f.id, "--as", "other-owner");
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).owner_sid).toBe(
		"other-owner",
	);
});

test("landed product commits do not bypass bounded failure and decision recording", () => {
	const f = fixture();
	for (let commit = 0; commit < 3; commit++) {
		writeFileSync(join(f.cwd, "feature.txt"), `implementation ${commit}\n`);
		f.git("add", "feature.txt");
		f.git("commit", "-qm", `progress ${commit}`);
	}
	expect(f.work("start", f.id, "--as", "dispatch-owner").code).toBe(0);
	for (let attempt = 1; attempt <= 3; attempt++)
		expect(f.stop().err).toContain(`Re-ask ${attempt}/3`);
	expect(f.stop().code).toBe(0);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	expect(row.state).toBe("FAILED");
	expect(row.completion).toBeNull();
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.item') = ?",
				)
				.get(row.project, f.id),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

test("a dispatched DONE item without its saved paragraph cannot stop", () => {
	const f = fixture();
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		const row = JSON.parse(f.work("show", f.id, "--json").out);
		db.query(
			"UPDATE work_items SET state='DONE', owner_sid=NULL WHERE project=? AND id=?",
		).run(row.project, f.id);
	} finally {
		db.close();
	}
	expect(f.stop().err).toContain(
		"DONE without verified saved completion evidence",
	);
});

test("a legacy manual DONE without lane context remains outside the lane gate", () => {
	const f = fixture();
	rmSync(join(f.cwd, ".fleet/lane-context.json"));
	f.work("release", f.id, "--as", "dispatch-owner");
	const tk = f.work("take", f.id, "--as", "manual-owner");
	const mtok = /claim token: ([0-9a-f]{48})/.exec(tk.out)?.[1];
	expect(
		f.work(
			"done",
			f.id,
			"--sha",
			f.git("rev-parse", "HEAD").out.trim(),
			...(mtok ? ["--token", mtok] : []),
		).code,
	).toBe(0);
	expect(f.stop().code).toBe(0);
});

test("first stop with work in flight offers one bounded continuation", () => {
	const f = fixture();
	const result = f.stopFresh();
	expect(result.err).toContain("One bounded continuation");
	expect(result.err).toContain("CHECKPOINT");
	expect(result.err).toContain(f.id);
	const marker = JSON.parse(
		readFileSync(join(f.cwd, ".fleet/completion-attempt.json"), "utf8"),
	);
	expect(marker.tries).toBe(1);
	// the loop guard ends the offer: the follow-up stops are plain re-asks
	// until the light budget (3) exhausts — FAILED on the next stop after
	expect(f.stop().err).toContain("Re-ask 2/3");
	expect(f.stop().err).toContain("Re-ask 3/3");
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("stop gate verifies a live claim through the repaired bin path (W1292)", () => {
	const f = fixture();
	const result = f.stopFresh();
	// past the verify stage: the bin resolution answers work show, so the
	// gate reaches attempt accounting instead of the broken-resolver refusal
	expect(result.err).not.toContain("cannot verify this lane's work claim");
	expect(result.err).toContain("One bounded continuation");
	const marker = JSON.parse(
		readFileSync(join(f.cwd, ".fleet/completion-attempt.json"), "utf8"),
	);
	expect(marker.tries).toBe(1);
});

test("a git-reachable capsule checkpoint parks the claimed item instead of failing it", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	writeFileSync(join(f.cwd, "checkpoint.txt"), "progress\n");
	f.git("add", "checkpoint.txt");
	f.git("commit", "-qm", "checkpoint progress");
	const sha = f.git("rev-parse", "HEAD").out.trim();
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${sha}`,
		"--done=progress committed",
		"--next=finish and work done",
	);
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
	const marker = JSON.parse(
		readFileSync(join(f.cwd, ".fleet/completion-attempt.json"), "utf8"),
	);
	expect(marker.outcome).toBe("PARKED");
});

test("a capsule checkpoint HEAD cannot reach does not park", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	// the producer refuses an arbitrary sha outright
	expect(
		f.coord(
			"capsule",
			"set",
			"--as",
			"dispatch-owner",
			"--item",
			f.id,
			"--checkpoint=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		).code,
	).not.toBe(0);
	// a real commit orphaned from HEAD cannot park either
	writeFileSync(join(f.cwd, "orphan.txt"), "orphan\n");
	f.git("add", "orphan.txt");
	f.git("commit", "-qm", "orphaned progress");
	const orphan = f.git("rev-parse", "HEAD").out.trim();
	f.git("reset", "-q", "--hard", "HEAD~1");
	expect(
		f.coord(
			"capsule",
			"set",
			"--as",
			"dispatch-owner",
			"--item",
			f.id,
			`--checkpoint=${orphan}`,
		).code,
	).toBe(0);
	expect(f.stop().err).toContain("Re-ask");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("a declared BLOCKED skips the checkpoint park and records FAILED", () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "progress.txt"), "real progress\n");
	f.git("add", "progress.txt");
	f.git("commit", "-qm", "checkpointed progress");
	const sha = f.git("rev-parse", "HEAD").out.trim();
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${sha}`,
		"--done=real parked progress",
		"--next=finish or declare",
	);
	expect(f.stop(`BLOCKED ${f.id}: upstream unavailable`).code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("a zero-progress checkpoint at the dispatch baseline cannot park", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	const base = f.git("rev-parse", "HEAD").out.trim();
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${base}`,
	);
	expect(f.stop().err).toContain("Re-ask");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("a legacy lane-scoped capsule without the item key cannot park", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	writeFileSync(join(f.cwd, "progress.txt"), "progress\n");
	f.git("add", "progress.txt");
	f.git("commit", "-qm", "progress");
	const sha = f.git("rev-parse", "HEAD").out.trim();
	// no --item: banks lane.<sid>.capsule only — no authoritative item link
	f.coord("capsule", "set", "--as", "dispatch-owner", `--checkpoint=${sha}`);
	expect(f.stop().err).toContain("Re-ask");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("a stale capsule timestamp cannot park", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	writeFileSync(join(f.cwd, "progress.txt"), "progress\n");
	f.git("add", "progress.txt");
	f.git("commit", "-qm", "progress");
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${f.git("rev-parse", "HEAD").out.trim()}`,
	);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		db.query("UPDATE facts SET ts = ? WHERE key = ?").run(
			Date.now() - 25 * 86_400_000,
			itemCapsuleKey(projectIdentity(f.cwd), f.id),
		);
	} finally {
		db.close();
	}
	expect(f.stop().err).toContain("Re-ask");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("a spoofed dispatch baseline cannot park", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	writeFileSync(join(f.cwd, "progress.txt"), "progress\n");
	f.git("add", "progress.txt");
	f.git("commit", "-qm", "progress");
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${f.git("rev-parse", "HEAD").out.trim()}`,
	);
	const context = JSON.parse(
		readFileSync(join(f.cwd, ".fleet/lane-context.json"), "utf8"),
	);
	context.baseline = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
	writeFileSync(
		join(f.cwd, ".fleet/lane-context.json"),
		JSON.stringify(context),
	);
	expect(f.stop().err).toContain("Re-ask");
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("an explicit NO_OP overrides a valid parked checkpoint", () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "progress.txt"), "progress\n");
	f.git("add", "progress.txt");
	f.git("commit", "-qm", "progress");
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${f.git("rev-parse", "HEAD").out.trim()}`,
	);
	expect(f.stop(`NO_OP ${f.id}: verified nothing left to do`).code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("FAILED with a pending decision retries recording once before permitting stop", () => {
	const f = fixture();
	expect(
		f.work("fail", f.id, "--as", "dispatch-owner", "--note", "incomplete").code,
	).toBe(0);
	const context = JSON.parse(
		readFileSync(join(f.cwd, ".fleet/lane-context.json"), "utf8"),
	);
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	writeFileSync(
		marker,
		JSON.stringify({
			...context,
			tries: 2,
			outcome: "FAILED",
			reason: "event write was interrupted",
			decisionPending: true,
		}),
	);
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(readFileSync(marker, "utf8")).decisionPending).toBe(false);
	expect(f.stop().code).toBe(0);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind='NEED_DECISION' AND json_extract(payload, '$.project')=? AND json_extract(payload, '$.item')=?",
				)
				.get(row.project, f.id),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

test("priority 2 (heavy) extends the continuation budget to 10", () => {
	const f = fixture(2);
	f.stopFresh(); // the offer burns slot 1
	for (let attempt = 2; attempt <= 6; attempt++)
		expect(f.stop().err).toContain(`Re-ask ${attempt}/10`);
	// light budget would have FAILED at re-ask 3/3 — still CLAIMED here
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("a stop past the class TTL resets the budget (engaged lane, new episode)", () => {
	const f = fixture(); // light: TTL 5min
	f.stopFresh(); // offer, tries=1, ts=now
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	const state = JSON.parse(readFileSync(marker, "utf8"));
	// backdate past the 5-minute light TTL
	state.ts = Date.now() - 6 * 60_000;
	writeFileSync(marker, JSON.stringify(state));
	expect(f.stop().err).toContain("Re-ask 1/3");
});

test("terminal-phase short-circuit: a parked activation stays concluded", () => {
	const f = fixture();
	f.stopFresh(); // burn the offer
	writeFileSync(join(f.cwd, "p.txt"), "progress\n");
	f.git("add", "p.txt");
	f.git("commit", "-qm", "checkpoint progress");
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${f.git("rev-parse", "HEAD").out.trim()}`,
		"--done=progress parked",
		"--next=resume and finish",
	);
	expect(f.stop().code).toBe(0); // parks
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	expect(JSON.parse(readFileSync(marker, "utf8")).outcome).toBe("PARKED");
	// later stops in the same session stay silent — no re-evaluation
	expect(f.stop().code).toBe(0);
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(readFileSync(marker, "utf8")).outcome).toBe("PARKED");
});

test("the continuation offer carries the actionable program (W686)", () => {
	const f = fixture();
	const base = f.git("rev-parse", "HEAD").out.trim();
	// a banked capsule's --next is the authoritative what-remains; banked at
	// the baseline so the park path refuses and the offer fires
	f.coord(
		"capsule",
		"set",
		"--as",
		"dispatch-owner",
		"--item",
		f.id,
		`--checkpoint=${base}`,
		"--next=verify the render, then close",
	);
	const result = f.stopFresh();
	expect(result.err).toContain("WHAT REMAINS: verify the render, then close");
	expect(result.err).toContain("CLOSE EXACTLY:");
	expect(result.err).toContain(`--sha ${base}`);
	expect(result.err).toContain("re-reading is not progress");
	expect(result.err).toContain("CHECKPOINT");
});

test("two unchanged continuations re-anchor with STALL; work breaks the streak", () => {
	const f = fixture();
	f.stopFresh(); // the offer banks the baseline signature
	expect(f.stop().err).not.toContain("STALL");
	const stalled = f.stop();
	expect(stalled.err).toContain("STALL:");
	expect(stalled.err).toContain("Re-ask 3/3");
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	expect(JSON.parse(readFileSync(marker, "utf8")).stall).toBe(2);
	// real work + a fresh episode (TTL backdate) breaks the streak
	writeFileSync(join(f.cwd, "progress.txt"), "progress\n");
	f.git("add", "progress.txt");
	f.git("commit", "-qm", "progress");
	const state = JSON.parse(readFileSync(marker, "utf8"));
	state.ts = Date.now() - 6 * 60_000; // past the light 5-min TTL
	writeFileSync(marker, JSON.stringify(state));
	const next = f.stop();
	expect(next.err).toContain("Re-ask 1/3");
	expect(next.err).not.toContain("STALL");
});

test("duplicate native Stop decisions replay without consuming another attempt", () => {
	const f = fixture();
	const first = f.stop();
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	expect(JSON.parse(readFileSync(marker, "utf8")).tries).toBe(1);
	// the SAME assistant turn re-fires the hook: the stored decision replays
	// verbatim, the attempt counter never moves
	expect(f.stopSame().err).toBe(first.err);
	expect(f.stopSame().err).toBe(first.err);
	expect(JSON.parse(readFileSync(marker, "utf8")).tries).toBe(1);
	// a genuinely new assistant turn consumes the next legitimate attempt
	expect(f.stop().err).toContain("Re-ask 2/3");
});

test("same assistant cannot cache a refusal over newly verified work done", () => {
	const f = fixture();
	f.stop();
	writeFileSync(join(f.cwd, "README.md"), "delivered documentation\n");
	f.git("add", "README.md");
	f.git("commit", "-qm", "delivered");
	const sha = f.git("rev-parse", "HEAD").out.trim();
	expect(
		f.work(
			"done",
			f.id,
			"--sha",
			sha,
			"--summary",
			"Delivered the documentation update and verified the saved completion record.",
		).code,
	).toBe(0);
	// terminal verification outranks the cached same-turn reply
	expect(f.stopSame().code).toBe(0);
});

test("concurrent duplicate native Stop hooks atomically spend exactly one attempt", async () => {
	const f = fixture();
	f.stop(); // seeds the normalized native transcript shape
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	rmSync(marker);
	const payload = join(f.cwd, ".fleet/concurrent-stop.json");
	writeFileSync(
		payload,
		JSON.stringify({
			cwd: f.cwd,
			session_id: "harness-uuid-different-from-owner",
			stop_hook_active: true,
			transcript_path: join(f.cwd, ".fleet/native-transcript.jsonl"),
		}),
	);
	const children = [0, 1].map(() =>
		Bun.spawn([process.execPath, join(source, "gate.ts"), "stop"], {
			cwd: f.cwd,
			env,
			stdin: Bun.file(payload),
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const results = await Promise.all(
		children.map(async (child) => ({
			error: await new Response(child.stderr).text(),
			code: await child.exited,
		})),
	);
	// the file lock serializes the pair: one decides, the other replays
	expect(results[0]?.error).toContain("Re-ask 1/3");
	expect(results[1]?.error).toBe(results[0]?.error);
	expect(JSON.parse(readFileSync(marker, "utf8")).tries).toBe(1);
});

test("bound parent receives no-output notice without restarting the stopped child", () => {
	const f = fixture();
	expect(
		f.coord(
			"bootstrap",
			"--as",
			"completion-supervisor",
			"--role",
			"coordinator",
		).code,
	).toBe(0);
	expect(
		f.coord(
			"bootstrap",
			"--as",
			"dispatch-owner",
			"--parent",
			"completion-supervisor",
		).code,
	).toBe(0);
	const transcript = join(f.cwd, ".fleet/native-transcript.jsonl");
	writeFileSync(
		transcript,
		`${JSON.stringify({ type: "assistant", uuid: "parent-notice", timestamp: new Date().toISOString(), isApiErrorMessage: true, message: { id: "parent-notice", role: "assistant", content: [] } })}\n`,
	);
	expect(f.stopSame().code).toBe(0);
	expect(f.stopSame().code).toBe(0);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT source,target FROM events WHERE kind='NEED_DECISION' AND json_extract(payload,'$.project')=? AND json_extract(payload,'$.item')=?",
				)
				.all(row.project, f.id),
		).toEqual([{ source: "dispatch-owner", target: "completion-supervisor" }]);
	} finally {
		db.close();
	}
});

test("distinct no-output turns each publish one event; same-turn duplicates stay silent", () => {
	const f = fixture();
	const transcript = join(f.cwd, ".fleet/native-transcript.jsonl");
	const emptyTurn = (id: string) =>
		writeFileSync(
			transcript,
			`${JSON.stringify({
				type: "assistant",
				uuid: `block-${id}`,
				timestamp: new Date().toISOString(),
				isApiErrorMessage: true,
				message: { id, role: "assistant", content: [] },
			})}\n`,
		);
	emptyTurn("error-a");
	expect(f.stopSame().code).toBe(0); // incident A: publishes
	expect(f.stopSame().code).toBe(0); // same-turn duplicate: silent
	emptyTurn("error-b");
	expect(f.stopSame().code).toBe(0); // incident B (new id): publishes
	expect(f.stopSame().code).toBe(0); // same-turn duplicate: silent
	// item ids are per-project: scope the count to THIS fixture's graph
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind='NEED_DECISION' AND json_extract(payload, '$.project')=? AND json_extract(payload, '$.item')=?",
				)
				.get(row.project, f.id),
		).toEqual({ n: 2 });
		expect(
			db
				.query(
					"SELECT source,target,json_extract(payload,'$.work') AS work FROM events WHERE kind='NEED_DECISION' AND json_extract(payload,'$.project')=? AND json_extract(payload,'$.item')=?",
				)
				.all(row.project, f.id),
		).toEqual([
			{ source: row.owner_sid, target: row.owner_sid, work: f.id },
			{ source: row.owner_sid, target: row.owner_sid, work: f.id },
		]);
	} finally {
		db.close();
	}
});

test("same-turn replay is bounded: past the no-new-assistant deadline the stop allows, typed and terminal", () => {
	const f = fixture();
	const first = f.stop();
	const marker = join(f.cwd, ".fleet/completion-attempt.json");
	expect(JSON.parse(readFileSync(marker, "utf8")).tries).toBe(1);
	// inside the deadline: idempotent replay
	expect(f.stopSame().err).toBe(first.err);
	// advance the clock past the light class's 5-minute no-new-assistant
	// deadline with the SAME turn id
	const state = JSON.parse(readFileSync(marker, "utf8"));
	state.ts = Date.now() - 6 * 60_000;
	writeFileSync(marker, JSON.stringify(state));
	const late = f.stopSame();
	// terminal typed allow-exit: never a re-ask, never DONE/FAILED, no spend
	expect(late.code).toBe(0);
	expect(late.err).not.toContain("Re-ask");
	const typed = JSON.parse(readFileSync(marker, "utf8"));
	expect(typed.outcome).toBe("TRANSPORT_BLOCKED");
	expect(typed.diagnostic).toBe("turn_deadline_exceeded");
	expect(typed.tries).toBe(1);
	// terminal: further duplicates stay allowed and silent, no new spend
	expect(f.stopSame().code).toBe(0);
	expect(JSON.parse(readFileSync(marker, "utf8")).tries).toBe(1);
	// the deadline incident published exactly ONE durable event
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	try {
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind='NEED_DECISION' AND json_extract(payload, '$.project')=? AND json_extract(payload, '$.item')=?",
				)
				.get(row.project, f.id),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});

// test/subscribe-tail.test.ts — W417.4: the push gate tails NEW
// subscribe-log lines into context, offset per lane. Unit leg pins the tail
// rules (offset advance, complete-lines-only, truncation reset, burst hold,
// ANSI strip); the gate leg spawns the REAL gate.ts push on a payload
// stream with HOME + TMPDIR isolated in a temp dir — delivery, silence on
// empty, and the SUSPENDERS_PUSH_TAIL=0 opt-out.
import { afterAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHOW_LINES, tailSubscribeLog } from "../hooks/gates/push.ts";
import { subagentLaneSuffix } from "../hooks/lib/subscribe-attach.ts";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-subtail-"));
const LOGDIR = join(TMP, ".claude-insights");
mkdirSync(LOGDIR, { recursive: true });

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function gate(
	payload: Record<string, unknown>,
	env: Record<string, string> = {},
) {
	const pf = join(TMP, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const p = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "push"],
		{
			cwd: TMP,
			env: {
				...process.env,
				HOME: TMP,
				SUSPENDERS_SID: "", // the lane env must not leak into the gate leg
				TMPDIR: TMP,
				...env,
			},
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

describe("subscribe tail lib", () => {
	test("no log yet: empty, offset unchanged", () => {
		const r = tailSubscribeLog(join(LOGDIR, "absent.log"), 12);
		expect(r).toEqual({ text: "", newOffset: 12 });
	});

	test("lines since offset; re-tail is silent; appends are the only new", () => {
		const log = join(LOGDIR, "t1.log");
		appendFileSync(log, "#1 first\n#2 second\n#3 third\n#4 fourth\n#5 fifth\n");
		const first = tailSubscribeLog(log, 0);
		expect(first.text).toContain("#1 first");
		expect(first.text).toContain("#5 fifth");
		expect(first.text.startsWith("WS INBOX +5:")).toBe(true);
		expect(tailSubscribeLog(log, first.newOffset).text).toBe("");
		appendFileSync(log, "#6 sixth\n#7 seventh\n");
		const second = tailSubscribeLog(log, first.newOffset);
		expect(second.text).toContain("#6 sixth");
		expect(second.text).toContain("#7 seventh");
		expect(second.text).not.toContain("#5 fifth");
	});

	test("partial last line is not consumed until its \\n lands", () => {
		const log = join(LOGDIR, "t2.log");
		appendFileSync(log, "#8 done\n#9 half-writt");
		const r1 = tailSubscribeLog(log, 0);
		expect(r1.text).toContain("#8 done");
		expect(r1.text).not.toContain("half-writt");
		appendFileSync(log, "en\n");
		const r2 = tailSubscribeLog(log, r1.newOffset);
		expect(r2.text).toContain("#9 half-written");
	});

	test("truncated log resets the offset", () => {
		const log = join(LOGDIR, "t3.log");
		appendFileSync(log, "a\nb\nc\n");
		const r1 = tailSubscribeLog(log, 0);
		expect(r1.text).toContain("a");
		// rewrite smaller: size < offset must reset to 0
		writeFileSync(log, "x\n");
		const r2 = tailSubscribeLog(log, r1.newOffset);
		expect(r2.text).toContain("x");
	});

	test("burst holds beyond the cap; held lines arrive next fire", () => {
		const log = join(LOGDIR, "t4.log");
		const lines = Array.from(
			{ length: SHOW_LINES + 5 },
			(_, i) => `#b${i + 1} line\n`,
		).join("");
		appendFileSync(log, lines);
		const r1 = tailSubscribeLog(log, 0);
		expect(r1.text).toContain(`WS INBOX +${SHOW_LINES} (+5 held):`);
		expect(r1.text).toContain("#b1 line");
		expect(r1.text).not.toContain(`#b${SHOW_LINES + 5} line`);
		const r2 = tailSubscribeLog(log, r1.newOffset);
		expect(r2.text).toContain("#b41 line");
		expect(r2.text).not.toContain("#b40 line");
		expect(r2.text).toContain("WS INBOX +5:");
	});

	test("ANSI codes are stripped from pushed lines", () => {
		const log = join(LOGDIR, "t5.log");
		appendFileSync(log, "  #9 raw 12s \x1B[36mwork.claimed\x1B[0m tail\n");
		const r = tailSubscribeLog(log, 0);
		expect(r.text).toContain("#9 raw 12s work.claimed tail");
		expect(r.text).not.toContain("\x1B");
	});
});

describe("push gate", () => {
	test("delivers new lines as PostToolUse additionalContext, then silences", () => {
		const sid = `wtest-${Math.random().toString(36).slice(2)}`;
		const log = join(LOGDIR, `coord-subscribe-${sid}.log`);
		appendFileSync(log, "#1 alpha consult: C7 pending\n#2 beta BROADCAST\n");
		const r = gate({ session_id: sid }, { SUSPENDERS_PUSH_TAIL: "" });
		expect(r.code).toBe(0);
		expect(r.out).toContain('"hookEventName":"PostToolUse"');
		expect(r.out).toContain("WS INBOX +2:");
		expect(r.out).toContain("#1 alpha consult: C7 pending");
		// offset per lane: the immediate second fire is silent
		const again = gate({ session_id: sid });
		expect(again.out).toBe("{}");
		// another lane's sid never sees this log
		expect(gate({ session_id: "wtest-other" }).out).toBe("{}");
	});

	test("lane id: SUSPENDERS_SID wins; subagent suffix rides transcript_path", () => {
		const sid = `wtest-env-${Math.random().toString(36).slice(2)}`;
		const log = join(LOGDIR, `coord-subscribe-${sid}.log`);
		appendFileSync(log, "#e1 env lane line\n");
		const r = gate(
			{ session_id: "wtest-uuid", cwd: TMP },
			{ SUSPENDERS_SID: sid },
		);
		expect(r.out).toContain("#e1 env lane line");
		expect(subagentLaneSuffix("/x/.claude/subagents/plotter.jsonl")).toBe(
			"#plotter",
		);
		expect(subagentLaneSuffix("/x/main.jsonl")).toBe("");
	});

	test("SUSPENDERS_PUSH_TAIL=0 opts out entirely", () => {
		const sid = `wtest-off-${Math.random().toString(36).slice(2)}`;
		const log = join(LOGDIR, `coord-subscribe-${sid}.log`);
		appendFileSync(log, "#z1 muted line\n");
		const r = gate({ session_id: sid }, { SUSPENDERS_PUSH_TAIL: "0" });
		expect(r.out).toBe("{}");
	});

	test("no session identity: silent allow", () => {
		expect(gate({ cwd: TMP }).out).toBe("{}");
	});
});

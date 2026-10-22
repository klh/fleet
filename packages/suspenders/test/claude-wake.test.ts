import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	consumeClaudeWake,
	signalClaudeDirectEvent,
	waitForClaudeWake,
} from "../hooks/lib/claude-wake.ts";

const home = mkdtempSync(join(tmpdir(), "fleet-claude-wake-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
// W670: lane envs carry SUSPENDERS_CLAUDE_WAKE=0 (the managed runtime pins it
// for native children) — pin the knob so native-consumer watchers arm here.
process.env.SUSPENDERS_CLAUDE_WAKE = "1";
const event = (id: number, target: string, kind = "NOTE") => ({
	id,
	target,
	kind,
	source: "peer",
	payload: JSON.stringify({ note: `direct instruction ${id}` }),
});

describe("Claude native hook wake bridge", () => {
	test("managed and native consumers have separate locks and shutdown cancels a watcher", async () => {
		const sid = "managed-and-native";
		const native = waitForClaudeWake(sid, { home, timeoutMs: 1000 });
		const managed = waitForClaudeWake(sid, {
			home,
			timeoutMs: 1000,
			consumer: "managed",
		});
		signalClaudeDirectEvent(event(41, sid), sid, home);
		expect(await native).toContain("#41");
		expect(await managed).toContain("#41");
		const abort = new AbortController();
		const waiting = waitForClaudeWake("shutdown", {
			home,
			timeoutMs: 1000,
			abort: abort.signal,
		});
		abort.abort();
		expect(
			await Promise.race([waiting, Bun.sleep(50).then(() => "still waiting")]),
		).toBeNull();
	});

	test("signals exact addressed messages and consults, never broadcasts", () => {
		const sid = "direct-only";
		expect(signalClaudeDirectEvent(event(1, "other"), sid, home)).toBe(false);
		expect(signalClaudeDirectEvent(event(2, sid, "BROADCAST"), sid, home)).toBe(
			false,
		);
		expect(consumeClaudeWake(sid, home)).toBeNull();
		for (const [i, kind] of ["NOTE", "consult", "consult.answer"].entries()) {
			expect(signalClaudeDirectEvent(event(i + 3, sid, kind), sid, home)).toBe(
				true,
			);
			const text = consumeClaudeWake(sid, home)?.text ?? null;
			expect(text).toContain(`direct instruction ${i + 3}`);
			expect(text).toContain(`coord inbox --as ${sid}`);
			expect(consumeClaudeWake(sid, home)).toBeNull();
		}
	});

	test("an armed watcher wakes on the filesystem event without polling", async () => {
		const sid = "watch-live";
		const waiting = waitForClaudeWake(sid, { home, timeoutMs: 1000 });
		signalClaudeDirectEvent(event(11, sid), sid, home);
		expect(await waiting).toContain("direct instruction 11");
	});

	test("one watcher per session; the next event can rearm after wake", async () => {
		const sid = "one-watcher";
		const waiting = waitForClaudeWake(sid, { home, timeoutMs: 1000 });
		expect(await waitForClaudeWake(sid, { home, timeoutMs: 20 })).toBeNull();
		signalClaudeDirectEvent(event(12, sid), sid, home);
		expect(await waiting).toContain("#12");
		const rearmed = waitForClaudeWake(sid, { home, timeoutMs: 1000 });
		signalClaudeDirectEvent(event(13, sid), sid, home);
		expect(await rearmed).toContain("#13");
	});

	test("replayed events cannot wake again, and no event times out silently", async () => {
		const sid = "replay";
		signalClaudeDirectEvent(event(30, sid), sid, home);
		expect(await waitForClaudeWake(sid, { home, timeoutMs: 20 })).toContain(
			"#30",
		);
		expect(signalClaudeDirectEvent(event(29, sid), sid, home)).toBe(false);
		expect(await waitForClaudeWake(sid, { home, timeoutMs: 20 })).toBeNull();
	});

	test("wiring arms native reawakening at bootstrap and every later boundary", () => {
		const settings = JSON.parse(
			readFileSync(
				join(import.meta.dir, "..", "settings.example.json"),
				"utf8",
			),
		);
		for (const name of [
			"SessionStart",
			"UserPromptSubmit",
			"PostToolUse",
			"Stop",
		]) {
			const hooks = settings.hooks[name].flatMap(
				(group: { hooks: unknown[] }) => group.hooks,
			);
			expect(hooks).toContainEqual({
				type: "command",
				command: "bun $HOME/.claude/hooks/suspenders/gate.ts claude-wake",
				asyncRewake: true,
				timeout: 86400,
			});
		}
	});
});

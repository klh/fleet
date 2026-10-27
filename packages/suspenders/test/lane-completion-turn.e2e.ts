// W1124.13 — the logical assistant turn key behind a Stop invocation.
// Helper-level: real native row shapes with synthetic identities/times.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionTurn } from "../hooks/lib/lanes/lane-completion-turn.ts";

const dir = mkdtempSync(join(tmpdir(), "completion-turn-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
const transcript = join(dir, "native.jsonl");
const activation = {
	sid: "fixture-owner",
	item: "W1",
	launchedAt: Date.parse("2026-01-01T00:00:00Z"),
};
/** Derived from native assistant/tool rows; content, paths, IDs and times replaced. */
const native = (uuid: string, id: string, name = "Edit") => ({
	type: "assistant",
	uuid,
	parentUuid: "fixture-parent",
	timestamp: "2026-01-01T00:01:00Z",
	message: {
		id,
		role: "assistant",
		stop_reason: "tool_use",
		content: [{ type: "tool_use", id: "fixture-tool", name, input: {} }],
	},
});

test("native Stop feedback without a new assistant retains the same logical turn", () => {
	const row = native("fixture-a", "fixture-message-a", "Read");
	writeFileSync(transcript, `${JSON.stringify(row)}\n`);
	const first = completionTurn({ transcript_path: transcript }, activation);
	writeFileSync(
		transcript,
		`${JSON.stringify(row)}\n${JSON.stringify({
			type: "user",
			uuid: "fixture-feedback",
			message: { role: "user", content: "Stop hook feedback" },
		})}\n`,
	);
	expect(completionTurn({ transcript_path: transcript }, activation)).toEqual(
		first,
	);
	expect(first.usable).toBe(true);
});

test("native message identity wins over per-block UUID; a real new message is a new turn", () => {
	writeFileSync(
		transcript,
		`${JSON.stringify(native("fragment-a", "message-a"))}\n`,
	);
	const first = completionTurn({ transcript_path: transcript }, activation);
	// a duplicated row (same message id, different block uuid) is the SAME turn
	writeFileSync(
		transcript,
		`${JSON.stringify(native("fragment-b", "message-a"))}\n`,
	);
	expect(completionTurn({ transcript_path: transcript }, activation).id).toBe(
		first.id,
	);
	writeFileSync(
		transcript,
		`${JSON.stringify(native("fragment-c", "message-b"))}\n`,
	);
	expect(
		completionTurn({ transcript_path: transcript }, activation).id,
	).not.toBe(first.id);
	// the activation scope is part of the hash: a relaunched lane never
	// inherits the previous episode's turn
	expect(
		completionTurn(
			{ transcript_path: transcript },
			{ ...activation, launchedAt: activation.launchedAt + 1 },
		).id,
	).not.toBe(first.id);
});

test("latest API-error/empty assistant is operational evidence, not the prior productive turn", () => {
	for (const latest of [
		{ ...native("error", "error-message"), isApiErrorMessage: true },
		{
			...native("empty", "empty-message"),
			message: { id: "empty-message", content: [] },
		},
	]) {
		writeFileSync(
			transcript,
			`${JSON.stringify(native("productive", "productive-message"))}\n${JSON.stringify(latest)}\n`,
		);
		const turn = completionTurn({ transcript_path: transcript }, activation);
		expect(turn.usable).toBe(false);
		// repeated identical failure frames stay one stable, non-usable turn
		const again = completionTurn({ transcript_path: transcript }, activation);
		expect(again.id).toBe(turn.id);
		expect(again.usable).toBe(false);
	}
});

test("missing and oversize transcripts degrade to typed diagnostics", () => {
	// no transcript anywhere on the resolution ladder → the typed transport miss
	expect(
		completionTurn({ transcript_path: join(dir, "absent.jsonl") }, activation)
			.reason,
	).toBe("transcript_unresolved");
	// a single assistant row larger than the bounded tail cannot be parsed —
	// the bounded reader reports assistant_not_observed rather than guessing
	writeFileSync(
		join(dir, "oversize.jsonl"),
		`${JSON.stringify({
			type: "assistant",
			uuid: "oversize",
			timestamp: "2026-01-01T00:01:00Z",
			message: {
				id: "oversize-message",
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(600 * 1024) }],
			},
		})}\n`,
	);
	expect(
		completionTurn({ transcript_path: join(dir, "oversize.jsonl") }, activation)
			.reason,
	).toBe("assistant_not_observed");
});

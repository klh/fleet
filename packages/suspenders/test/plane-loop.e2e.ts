// test/plane-loop.test.ts — W266.2 plane-loop gate primitives: keyword-past
// command words, unbounded `while`/`until` head classification over the REAL
// gateSegments tokenizer, and the logged plane-exempt escape (audit lands in
// a HOME-swapped fixture — never the real denied-calls.jsonl).
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateSegments } from "../hooks/gates/bash-hardening.ts";
import {
	PLANE_VERBS,
	segVerb,
	unboundedLoopHead,
} from "../hooks/gates/plane-loop.ts";
test.describe("@unit", () => {

test.describe("segVerb (past do/then/else keywords)", () => {
	test("do-prefixed loop body", () =>
		expect(segVerb(["do", "coord", "ping"])).toBe("coord"));
	test("plain command", () => expect(segVerb(["coord", "ping"])).toBe("coord"));
	test("wrapper before the keyword", () =>
		expect(segVerb(["sudo", "-u", "root", "do", "coord"])).toBe("coord"));
	test("keyword-only segment", () => expect(segVerb(["done"])).toBe("done"));
	test("empty segment", () => expect(segVerb([])).toBe(""));
});

test.describe("unboundedLoopHead over gateSegments", () => {
	const head = (cmd: string) => unboundedLoopHead(gateSegments(cmd)[0] ?? []);
	test("while true", () => expect(head("while true; do x; done")).toBe(true));
	test("while :", () => expect(head("while :; do x; done")).toBe(true));
	test("while /bin/true", () =>
		expect(head("while /bin/true; do x; done")).toBe(true));
	test("until false", () => expect(head("until false; do x; done")).toBe(true));
	test("bounded for → false", () =>
		expect(head("for i in 1 2 3; do x; done")).toBe(false));
	test("while with a real condition → false", () =>
		expect(head("while ! curl -sf x; do y; done")).toBe(false));
	test("while sleep → false (real condition, documented scope cut)", () =>
		expect(head("while sleep 60; do x; done")).toBe(false));
	test("plain command → false", () => expect(head("coord ping")).toBe(false));
});

test.describe("plane-verb vocabulary", () => {
	test("coord/fleet-loop/board are the plane verbs", () => {
		expect(PLANE_VERBS.has("coord")).toBe(true);
		expect(PLANE_VERBS.has("fleet-loop")).toBe(true);
		expect(PLANE_VERBS.has("board")).toBe(true);
		expect(PLANE_VERBS.has("work")).toBe(false);
	});
});

test.describe("auditEscape (HOME-swapped fixture)", () => {
	test("plane-exempt escape lands in denied-calls.jsonl", () => {
		const home = mkdtempSync(join(realpathSync(tmpdir()), "plane-audit-"));
		const prev = process.env.HOME;
		try {
			process.env.HOME = home;
			const { auditEscape } = require("../hooks/lib/hookio.ts");
			auditEscape("plane-loop-gate: plane-exempt escape (test fixture)");
		} finally {
			process.env.HOME = prev;
		}
		const file = join(home, ".cache/claude-governor/denied-calls.jsonl");
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
			tool?: string;
		};
		expect(last.tool).toBe("plane-exempt");
		rmSync(home, { recursive: true, force: true });
	});
});

});

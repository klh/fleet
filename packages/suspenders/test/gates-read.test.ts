// test/gates-read.test.ts — W110 read gate (fat-read deny + re-read nudge).
//   1. pure: readCapBytes parsing + fatReadDeny decision core
//   2. gate-level: real `bun hooks/gate.ts pre-read` spawns — deny carries the
//      size and the bounded retry; 3rd same-path read emits additionalContext
// Fixtures: mkdtemp under cwd, unique path per test, TMPDIR isolated per run
// so the re-read counters never leak between runs.
import { describe, test, expect, afterAll } from "bun:test";
import {
	fatReadDeny,
	readCapBytes,
	dataSliceDeny,
	DEFAULT_MAX_READ,
} from "../hooks/gates/read.ts";
import { clampHeadTail, readSliceLines } from "../hooks/lib/clamp.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmp = mkdtempSync(join(process.cwd(), ".read-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sizedFixture(name: string, bytes: number): string {
	const f = join(tmp, name);
	writeFileSync(f, "x".repeat(bytes));
	return f;
}

const SID = "read-test-lane";
const hook = (input: Record<string, unknown>) => ({
	tool_name: "Read",
	tool_input: input,
	cwd: process.cwd(),
	session_id: SID,
});

function spawnGate(payload: unknown, env: Record<string, string> = {}) {
	const pf = join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "pre-read"],
		{
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
			cwd: import.meta.dir,
			env: { ...process.env, TMPDIR: tmp, ...env },
		},
	);
	rmSync(pf);
	let json: {
		hookSpecificOutput?: {
			permissionDecision?: string;
			permissionDecisionReason?: string;
			additionalContext?: string;
		};
	} | null = null;
	try {
		json = JSON.parse(r.stdout.toString());
	} catch {}
	return { code: r.exitCode, json };
}
const decision = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
const reason = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const nudgeText = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.additionalContext ?? "";

// ============================== pure ==============================

describe("readCapBytes (SUSPENDERS_MAX_READ)", () => {
	test("unset → default 40KB", () =>
		expect(readCapBytes(undefined)).toBe(DEFAULT_MAX_READ));
	test("blank → default", () =>
		expect(readCapBytes("  ")).toBe(DEFAULT_MAX_READ));
	test("positive integer honored", () =>
		expect(readCapBytes("2048")).toBe(2048));
	test("0 disables", () => expect(readCapBytes("0")).toBe(0));
	test("negatives and garbage disable", () => {
		expect(readCapBytes("-3")).toBe(0);
		expect(readCapBytes("abc")).toBe(0);
		expect(readCapBytes("4.5")).toBe(0);
	});
});

describe("fatReadDeny (pure core)", () => {
	const P = "/repo/big.ts";
	test("small file → null", () =>
		expect(fatReadDeny(1024, false, 40_960, P)).toBeNull());
	test("big file with limit → null", () =>
		expect(fatReadDeny(50_000, true, 40_960, P)).toBeNull());
	test("big file no limit → reason with size + bounded retry", () => {
		const m = fatReadDeny(122_880, false, 40_960, P) ?? "";
		expect(m).toContain("120KB");
		expect(m).toContain("limit");
		expect(m).toContain("SUSPENDERS_MAX_READ");
	});
	test("cap 0 disables", () =>
		expect(fatReadDeny(999_999, false, 0, P)).toBeNull());
	test("media extensions exempt", () => {
		expect(fatReadDeny(500_000, false, 40_960, "/repo/scan.png")).toBeNull();
		expect(fatReadDeny(500_000, false, 40_960, "/repo/deck.pdf")).toBeNull();
	});
});

// ============================== gate: pre-read spawns ==============================

describe("readGate — live pre-read spawns", () => {
	test("pre-read: >40KB file without limit → deny with size + guidance", () => {
		const f = sizedFixture(
			`big-${Math.random().toString(36).slice(2)}.txt`,
			50 * 1024,
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("read-gate:");
		expect(reason(r)).toContain("50KB");
	});

	test("pre-read: same file with limit → allow", () => {
		const f = sizedFixture(
			`big-${Math.random().toString(36).slice(2)}.txt`,
			50 * 1024,
		);
		const r = spawnGate(hook({ file_path: f, limit: 400 }));
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: small file → allow", () => {
		const f = sizedFixture(
			`small-${Math.random().toString(36).slice(2)}.txt`,
			1024,
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: media extension exempt from the fat-read deny", () => {
		const f = sizedFixture(
			`scan-${Math.random().toString(36).slice(2)}.png`,
			60 * 1024,
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: SUSPENDERS_MAX_READ=0 disables the deny", () => {
		const f = sizedFixture(
			`big-${Math.random().toString(36).slice(2)}.txt`,
			50 * 1024,
		);
		const r = spawnGate(hook({ file_path: f }), { SUSPENDERS_MAX_READ: "0" });
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: 3rd same-path read → additionalContext nudge, read proceeds", () => {
		const f = sizedFixture(
			`rereread-${Math.random().toString(36).slice(2)}.txt`,
			1024,
		);
		const first = spawnGate(hook({ file_path: f }));
		const second = spawnGate(hook({ file_path: f }));
		const third = spawnGate(hook({ file_path: f }));
		expect(decision(first)).toBe("allow");
		expect(nudgeText(first)).toBe("");
		expect(decision(second)).toBe("allow");
		expect(decision(third)).toBe("allow"); // nudge is non-blocking
		expect(nudgeText(third)).toContain("read-gate: read #3");
		expect(nudgeText(third)).toContain(f.slice(f.lastIndexOf("/") + 1)); // basename — nudges stay compact
	});

	test("pre-read: SUSPENDERS_REREAD_NUDGE=0 silences the nudge", () => {
		const f = sizedFixture(
			`quiet-${Math.random().toString(36).slice(2)}.txt`,
			1024,
		);
		for (let i = 0; i < 3; i++) {
			const r = spawnGate(hook({ file_path: f }), {
				SUSPENDERS_REREAD_NUDGE: "0",
			});
			expect(nudgeText(r)).toBe("");
		}
	});
});

// ===================== W252: auto-clamp + data-file rule =====================

describe("clampHeadTail (pure core)", () => {
	const cap = 40_960;
	test("small text → null", () =>
		expect(clampHeadTail("x".repeat(1024), cap)).toBeNull());
	test("cap 0 / negative → null (disabled)", () => {
		expect(clampHeadTail("x".repeat(999_999), 0)).toBeNull();
		expect(clampHeadTail("x".repeat(999_999), -1)).toBeNull();
	});
	test("elides the middle, keeps first+last lines, honest accounting", () => {
		const lines = Array.from(
			{ length: 400 },
			(_, i) => `line-${String(i).padStart(4, "0")}-${"y".repeat(400)}`,
		);
		const text = lines.join("\n");
		const c = clampHeadTail(text, cap);
		expect(c).not.toBeNull();
		if (!c) return;
		expect(c.text).toContain("line-0000");
		expect(c.text).toContain("line-0399");
		expect(c.text).not.toContain("line-0200"); // middle elided
		expect(c.text).toMatch(/clamp-gate: \d+KB \/ \d+ lines elided/);
		expect(c.elidedLines).toBeGreaterThan(0);
		expect(c.elidedBytes).toBeGreaterThan(0);
	});
	test("clamped view stays within cap", () => {
		const text = Array.from(
			{ length: 2000 },
			(_, i) => `r-${i} ${"d".repeat(120)}`,
		).join("\n");
		const c = clampHeadTail(text, cap);
		expect(c).not.toBeNull();
		if (!c) return;
		expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(cap);
	});
	test("line-snapped: tail begins at a line start", () => {
		const text = Array.from({ length: 500 }, (_, i) =>
			`L${i};`.repeat(20),
		).join("\n");
		const c = clampHeadTail(text, cap);
		expect(c).not.toBeNull();
		if (!c) return;
		const m = c.text.indexOf("clamp-gate:");
		const tailStart = c.text.indexOf("\n", m) + 1;
		expect(c.text.slice(tailStart)).toMatch(/^L\d+;/);
	});
});

describe("dataSliceDeny (pure core)", () => {
	const P = "/repo/feed.jsonl";
	test("thin slice → null", () =>
		expect(dataSliceDeny(1024, 400, 40_960, P)).toBeNull());
	test("cap 0 disables", () =>
		expect(dataSliceDeny(999_999, 400, 0, P)).toBeNull());
	test("fat slice → reason with size, limit, data-specific guidance", () => {
		const m = dataSliceDeny(120 * 1024, 900, 40_960, P) ?? "";
		expect(m).toContain("120KB");
		expect(m).toContain("limit: 900");
		expect(m).toContain("tail/rg/jq");
		expect(m).toContain("SUSPENDERS_MAX_READ");
	});
});

describe("readSliceLines (pure core)", () => {
	const text = "a\nb\nc\nd\ne";
	test("full window from offset 0", () =>
		expect(readSliceLines(text, 0, 3)).toBe("a\nb\nc"));
	test("offset windows into the middle", () =>
		expect(readSliceLines(text, 2, 2)).toBe("c\nd"));
	test("limit past EOF truncates", () =>
		expect(readSliceLines(text, 3, 99)).toBe("d\ne"));
});

describe("readGate W252 — clamp + data-file spawns", () => {
	function jsonlFixture(name: string, lines: string[]): string {
		const f = join(tmp, name);
		writeFileSync(f, lines.join("\n"));
		return f;
	}
	const feedLines = (n: number): string[] =>
		Array.from(
			{ length: n },
			(_, i) =>
				`record-${String(i).padStart(4, "0")} ${"payload".padEnd(60, ".")}`,
		);

	test("no-limit Read of fat .txt → deny carries the clamped view", () => {
		const f = join(tmp, "clampview.txt");
		writeFileSync(f, `HEAD-SENTINEL\n${"x".repeat(60 * 1024)}\nTAIL-SENTINEL`);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("HEAD-SENTINEL");
		expect(reason(r)).toContain("TAIL-SENTINEL");
		expect(reason(r)).toContain("clamped head+tail view");
		expect(reason(r)).toContain("clamp-gate:");
	});
	test("no-limit Read of fat .jsonl → deny with head+tail records + marker", () => {
		const f = jsonlFixture(
			`feed-${Math.random().toString(36).slice(2)}.jsonl`,
			feedLines(1200),
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("record-0000");
		expect(reason(r)).toContain("record-1199");
		expect(reason(r)).toMatch(/clamp-gate: \d+KB \/ \d+ lines elided/);
	});
	test("fat .jsonl with fat-slice limit → data-rule deny + clamped slice", () => {
		// big records LAST and under half-cap: the line-snap keeps the final
		// complete fat record (big2) whole and elides the partial one (big1)
		// into the middle — the clamp shows the newest fat record unsplit.
		const f = jsonlFixture("fatline.jsonl", [
			...feedLines(500),
			"big1".padEnd(12 * 1024, "b"),
			"big2".padEnd(12 * 1024, "c"),
		]);
		const r = spawnGate(hook({ file_path: f, limit: 502 }));
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("slice (limit: 502)");
		expect(reason(r)).toContain("big2");
		expect(reason(r)).not.toContain("big1"); // partial line → elided middle
		expect(reason(r)).toMatch(/clamp-gate: \d+KB \/ \d+ lines elided/);
	});
	test("fat .jsonl with thin-slice limit → allow", () => {
		const f = jsonlFixture("thin.jsonl", feedLines(300));
		const r = spawnGate(hook({ file_path: f, limit: 100 }));
		expect(decision(r)).toBe("allow");
	});
	test("fat slice, SUSPENDERS_MAX_READ=0 → allow (disabled)", () => {
		const f = jsonlFixture("disabled.jsonl", [
			...feedLines(10),
			"big1".padEnd(60 * 1024, "b"),
		]);
		const r = spawnGate(hook({ file_path: f, limit: 11 }), {
			SUSPENDERS_MAX_READ: "0",
		});
		expect(decision(r)).toBe("allow");
	});
});

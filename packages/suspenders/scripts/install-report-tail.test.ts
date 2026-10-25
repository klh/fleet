// install-report-tail.test.ts — W899: the install tail proves `work report`
// live (acceptance (a)): shim-first door (acceptance (b) — the PATH shim is
// THE door), prefix-bin fallback when no shim exists, verb death mapped to
// ok:false with stderr carried. Faked runner; one real shim-door spawn.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRunner, reportTail, stackVersionTail } from "./install-report-tail.ts";

const TABLE = "ITEM  ST  TASK\n----  --  ----\n";

const tempDir = (label: string): string =>
	mkdtempSync(join(tmpdir(), `w899-${label}-`));

describe("install report tail (W899)", () => {
	const prefix = tempDir("prefix");
	const shimBin = tempDir("shims");
	writeFileSync(join(shimBin, "work"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

	test("shim door: an existing shim runs `work report` through it", () => {
		const seen: string[][] = [];
		const r = reportTail({ prefix, shimBin }, (run) => {
			seen.push(run);
			return { code: 0, out: TABLE, err: "" };
		});
		expect(r.ok).toBe(true);
		expect(r.source).toBe("shim");
		expect(seen[0]).toEqual([join(shimBin, "work"), "report"]);
	});

	test("prefix fallback door when the shim is absent", () => {
		const r = reportTail(
			{ prefix, shimBin: tempDir("empty-shims") },
			() => ({ code: 0, out: TABLE, err: "" }),
		);
		expect(r.source).toBe("prefix");
	});

	test("verb death maps to ok:false, stderr carried", () => {
		const r = reportTail({ prefix, shimBin }, () => ({
			code: 1,
			out: "",
			err: "unknown command: report",
		}));
		expect(r.ok).toBe(false);
		expect(r.out).toBe("");
		expect(r.err).toContain("unknown command");
	});
});

describe("install report tail — the real shim door (W899)", () => {
	test("processRunner execs the shim binary and captures its table", () => {
		const shimBin = tempDir("real-shims");
		const prefix = tempDir("real-prefix");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(
			join(shimBin, "work"),
			'#!/bin/sh\necho "ITEM  ST  TASK"\n',
			{ mode: 0o755 },
		);
		const r = reportTail({ prefix, shimBin }, processRunner);
		expect(r.ok).toBe(true);
		expect(r.source).toBe("shim");
		expect(r.out).toContain("ITEM");
	});
});

describe("stack version tail (W1303.6)", () => {
	test("renders the one-version evidence line against the real repo", () => {
		const repo = new URL("../../..", import.meta.url).pathname;
		const line = stackVersionTail(repo);
		expect(line).toContain("STACK VERSION PIN");
		// render-only: no repo file changed by rendering the hint
		const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"]);
		expect(new TextDecoder().decode(status.stdout ?? new Uint8Array()).trim()).not.toContain("stack.json");
	});
});

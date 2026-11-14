// test/stop-changed-code-cap.e2e.ts — W3084: the Stop gate's changed-code
// re-verification loop is UNBOUNDED. The old 50-file cap silently skipped
// the tail of any >50-file change set (its "verify the rest manually" had
// no receipt mechanism), so a real filesCheck failure past position 50
// never blocked the stop. The REAL gate.ts stop runs over a scratchWorld
// repo; qlty is pinned OFF the child PATH (the fixture has no .qlty setup —
// the same exit-99 skip spirit as stop-knowledge-ask's temp repos) so the
// deterministic filesCheck verdicts carry the assertions.
import { expect, test } from "@playwright/test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchWorld, type ScratchWorld } from "@klh/test-kit";

const GATE = new URL("../hooks/gate.ts", import.meta.url).pathname;

/** A stub `qlty` on the child PATH: logs every invocation to $STOPCAP_QLTY_LOG
 * (mode + every argument after it), MUTATES the target on `fmt` (teeth — a Stop
 * that formats fails the byte assertions), exits 99 ("not set up") so the gate
 * keeps verifying while the real toolchain never loads. With $STOPCAP_QLTY_FAIL
 * a `check` reports issues and exits 1 — the real-failure path. */
function stubQlty(w: ScratchWorld): { bin: string; log: string } {
	const stubBin = join(w.home, "stub-bin");
	mkdirSync(stubBin, { recursive: true });
	const stub = join(stubBin, "qlty");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bun",
			"import { appendFileSync, existsSync } from 'node:fs';",
			"const log = process.env.STOPCAP_QLTY_LOG;",
			"const mode = process.argv[2];",
			"const args = process.argv.slice(3);",
			"const target = args[args.length - 1];",
			"if (log) appendFileSync(log, mode + ' ' + args.join(' ') + ' ' + process.cwd() + '\\n');",
			"if (mode === 'fmt' && target) {",
			"	const f = process.cwd() + '/' + target;",
			"	if (existsSync(f)) appendFileSync(f, '// stop-formatted-me\\n');",
			"}",
			"if (mode === 'check' && process.env.STOPCAP_QLTY_FAIL) {",
			"	console.log('stub-lint: fake issue in ' + target);",
			"	process.exit(1);",
			"}",
			"process.exit(99);",
		].join("\n"),
	);
	chmodSync(stub, 0o755);
	return { bin: stubBin, log: join(w.home, "qlty.log") };
}

/** One harmless changed code file, one file PAST the old 50-file cap whose
 * filesCheck verdict is deterministic everywhere (a .ts past the 1500-line
 * law trips the gate without any qlty setup). Sorted so `zz-bad.ts` is the
 * LAST porcelain entry — the old cap broke at 50, skipping it entirely. */
function changedCorpus(repo: string): void {
	for (let i = 1; i <= 59; i++)
		writeFileSync(
			join(repo, `f${String(i).padStart(2, "0")}.ts`),
			"const ok = 1;\n",
		);
	writeFileSync(join(repo, "zz-bad.ts"), `const pad = 1;\n`.repeat(1600));
}

function stop(
	w: ScratchWorld,
	sessionId: string,
	path?: string,
	extraEnv: Record<string, string> = {},
) {
	const payload = join(w.home, "stop-input.json");
	writeFileSync(
		payload,
		JSON.stringify({
			cwd: w.repo,
			session_id: sessionId,
			hook_event_name: "Stop",
			stop_hook_active: true,
		}),
	);
	// git stays reachable (the gate fail-opens `allow()` without it) while
	// qlty (~/.local/bin) does not — the fixture repo is never qlty-set-up.
	const toolBin = dirname(Bun.which("git") ?? "/usr/bin/git");
	const p = Bun.spawnSync([process.execPath, GATE, "stop"], {
		cwd: w.repo,
		env: {
			...w.env,
			PATH: path ?? `${toolBin}:/usr/bin:/bin`,
			STOPCAP_QLTY_LOG: join(w.home, "qlty.log"),
			...extraEnv,
		},
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

test.describe("@unit", () => {
	test("a filesCheck failure past the old 50-file cap still blocks Stop", () => {
		const w = scratchWorld({ prefix: "stop-cap-" });
		try {
			changedCorpus(w.repo);
			const s = stop(w, "stop-cap-sess");
			expect(s.code).toBe(2);
			expect(s.err).toContain("STOP-GATE");
			expect(s.err).toContain("zz-bad.ts"); // verified PAST the old cap
			expect(s.err).not.toContain("verify the rest manually");
		} finally {
			w.clean();
		}
	});

	test("a clean >50-file tree allows Stop — scaling adds no false failures", () => {
		const w = scratchWorld({ prefix: "stop-cap-clean-" });
		try {
			for (let i = 1; i <= 60; i++)
				writeFileSync(
					join(w.repo, `f${String(i).padStart(2, "0")}.ts`),
					"const ok = 1;\n",
				);
			const s = stop(w, "stop-cap-clean-sess");
			expect(s.code).toBe(0);
			expect(s.out).toBe("{}");
			expect(s.err).not.toContain("STOP-GATE");
		} finally {
			w.clean();
		}
	});

	test("unmerged paths still block Stop alongside the full-file scan", () => {
		const w = scratchWorld({ prefix: "stop-cap-uu-" });
		try {
			const g = (...args: string[]) =>
				Bun.spawnSync(["git", "-C", w.repo, ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
			writeFileSync(join(w.repo, "f.ts"), "base\n");
			g("add", "f.ts");
			g("commit", "-qm", "base2");
			g("checkout", "-q", "-b", "side");
			writeFileSync(join(w.repo, "f.ts"), "side\n");
			g("commit", "-qam", "side");
			g("checkout", "-q", "main");
			writeFileSync(join(w.repo, "f.ts"), "main\n");
			g("commit", "-qam", "main");
			g("merge", "side");
			changedCorpus(w.repo);
			const s = stop(w, "stop-cap-uu-sess");
			expect(s.code).toBe(2);
			expect(s.err).toContain("STOP-GATE");
			expect(s.err).toContain("unmerged: f.ts");
			expect(s.err).toContain("zz-bad.ts");
			expect(s.err).not.toContain("verify the rest manually");
		} finally {
			w.clean();
		}
	});

	test("Stop never formats and checks ONCE — bytes intact (stub qlty has teeth)", () => {
		const w = scratchWorld({ prefix: "stop-cap-bytes-" });
		try {
			const { bin: stubBin, log: qlog } = stubQlty(w);
			changedCorpus(w.repo);
			const read = (name: string) => readFileSync(join(w.repo, name), "utf8");
			const nm = (i: number) => `f${String(i).padStart(2, "0")}.ts`;
			const before = new Map(
				[...Array(59).keys()].map((i) => [nm(i + 1), read(nm(i + 1))]),
			);
			before.set("zz-bad.ts", read("zz-bad.ts"));
			const s = stop(
				w,
				"stop-cap-bytes-sess",
				`${stubBin}:${dirname(Bun.which("git") ?? "/usr/bin/git")}:/usr/bin:/bin`,
			);
			const log = readFileSync(qlog, "utf8").trim().split("\n");
			const checks = log.filter((l) => l.startsWith("check "));
			expect(s.code).toBe(2);
			expect(s.err).toContain("zz-bad.ts"); // real failure still verified
			expect(checks.length).toBe(1); // W3086: ONE batch check, not 60
			expect(checks[0]).toContain("--no-formatters");
			for (let i = 1; i <= 59; i++) expect(checks[0]).toContain(nm(i)); // all paths
			expect(checks[0]).toContain("zz-bad.ts");
			expect(log.filter((l) => l.startsWith("fmt ")).length).toBe(0); // none formatted
			for (const [n, c] of before) expect(read(n)).toBe(c); // bytes intact
		} finally {
			w.clean();
		}
	});

	test("a real qlty failure in the batch check still blocks Stop", () => {
		const w = scratchWorld({ prefix: "stop-cap-qfail-" });
		try {
			const { bin: stubBin } = stubQlty(w);
			changedCorpus(w.repo);
			const s = stop(
				w,
				"stop-cap-qfail-sess",
				`${stubBin}:${dirname(Bun.which("git") ?? "/usr/bin/git")}:/usr/bin:/bin`,
				{ STOPCAP_QLTY_FAIL: "1" },
			);
			expect(s.code).toBe(2);
			expect(s.err).toContain("STOP-GATE");
			expect(s.err).toContain(
				"qlty check found issues across 60 changed files",
			);
			expect(s.err).toContain("stub-lint: fake issue");
		} finally {
			w.clean();
		}
	});

	test("205 changed files: one qlty spawn, bounded wall time", () => {
		const w = scratchWorld({ prefix: "stop-cap-large-" });
		try {
			const { bin: stubBin, log: qlog } = stubQlty(w);
			for (let i = 1; i <= 205; i++)
				writeFileSync(
					join(w.repo, `g${String(i).padStart(3, "0")}.ts`),
					"const ok = 1;\n",
				);
			const t0 = Date.now();
			const s = stop(
				w,
				"stop-cap-large-sess",
				`${stubBin}:${dirname(Bun.which("git") ?? "/usr/bin/git")}:/usr/bin:/bin`,
			);
			const ms = Date.now() - t0;
			const log = readFileSync(qlog, "utf8").trim().split("\n");
			test.info().annotations.push({
				type: "stop-205-files-ms",
				description: `${ms}`,
			});
			expect(s.code).toBe(0); // clean tree allows
			expect(log.filter((l) => l.startsWith("check ")).length).toBe(1);
			expect(log.filter((l) => l.startsWith("fmt ")).length).toBe(0);
			expect(ms).toBeLessThan(60_000); // per-file spawning measured >150s
		} finally {
			w.clean();
		}
	});
});

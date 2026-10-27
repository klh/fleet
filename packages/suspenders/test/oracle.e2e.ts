// oracle.test.ts — W647: the named review/escalation tool. Contract pins
// (W1119.1): the three fixed frames ride as the user message (review's
// VERDICT line matches review-lane.ts's parse), BOTH legs ride the ONE
// shared gated Buckle client (SUSPENDERS_BUCKLE_URL/TOKEN — the pinned leg
// with hint 'prefer local reasoning' + the ORACLE_ROUTE_MODEL data pin,
// --cloud the same gate with hint 'prefer cloud' + glm-5.3), absent gate
// config is an honest exit 2, and the call is stateless (two calls,
// byte-identical request bodies).
import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.setTimeout(30_000);

const ORACLE = join(import.meta.dir, "..", "hooks", "bin", "oracle.ts");

type Seen = {
	path: string;
	key: string | null;
	hint: string | null;
	body: Record<string, unknown>;
};

// one stub answers both wires: /v1/messages → anthropic, else OpenAI chat;
// `vary` serves its entries per hit (last repeats) — the panel fan-out needs
// different verdicts per leg through the ONE gate
function makeStub(content: string, status = 200, vary?: string[]) {
	const seen: Seen[] = [];
	let n = 0;
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			const text = vary
				? (vary[Math.min(n++, vary.length - 1)] ?? content)
				: content;
			seen.push({
				path: url.pathname,
				key: req.headers.get("x-api-key"),
				hint: req.headers.get("x-belt-hint"),
				body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
			});
			const reply = url.pathname.endsWith("/v1/messages")
				? { content: [{ type: "text", text }] }
				: { choices: [{ message: { content: text } }] };
			return Response.json(reply, { status });
		},
	});
	return {
		srv,
		seen,
		base: `http://127.0.0.1:${srv.port}`,
		chat: `http://127.0.0.1:${srv.port}/v1/chat/completions`,
		stop: () => srv.stop(true),
	};
}

// the W1119.1 credential pair: every leg resolves the ONE gate (env form)
function gateEnv(
	s: { base: string },
	over: Record<string, string> = {},
): Record<string, string> {
	return {
		...over,
		SUSPENDERS_BUCKLE_URL: s.base,
		SUSPENDERS_BUCKLE_TOKEN: "bksk_fixt",
	};
}

// c2 — spawn + git helpers for the oracle suite (spliced into oracle.test.ts)
const keep: string[] = [];
test.afterAll(() => {
	for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function run(
	args: string[],
	opts: {
		env?: Record<string, string>;
		unset?: string[];
		home?: string;
		cwd?: string;
		stdin?: string;
	} = {},
): Promise<{ code: number | null; out: string; err: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		...opts.env,
		HOME: opts.home ?? process.env.HOME,
	};
	for (const k of opts.unset ?? []) delete env[k];
	return new Promise((resolve) => {
		const child = Bun.spawn([process.execPath, ORACLE, ...args], {
			cwd: opts.cwd,
			env,
			stdin: opts.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (opts.stdin !== undefined) {
			child.stdin.write(opts.stdin);
			child.stdin.end();
		}
		Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]).then(([code, out, err]) => resolve({ code, out, err }));
	});
}

function gitRun(args: string[], cwd: string): string {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.stdout.toString();
}

// a scratch git repo with one committed file (input-source test)
function gitDir(keep: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "oracle-w647-git-"));
	keep.push(dir);
	mkdirSync(dir, { recursive: true });
	gitRun(["init", "-q"], dir);
	gitRun(
		[
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"seed",
		],
		dir,
	);
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	gitRun(["add", "."], dir);
	gitRun(
		[
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"-m",
			"add a",
		],
		dir,
	);
	return dir;
}

// c3 — test units (top-level test() calls; each chunk must parse standalone)
test("review pins the fixed frame + payload to the configured gate", async () => {
	const s = makeStub("looks fine\nVERDICT: STUBPASS");
	const dir = mkdtempSync(join(tmpdir(), "oracle-w647-"));
	const file = join(dir, "d.diff");
	writeFileSync(file, "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n");
	try {
		const r = await run(["review", "--in", file], {
			env: gateEnv(s, { ORACLE_ROUTE_MODEL: "fixture-reason" }),
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("VERDICT: STUBPASS");
		expect(r.err).toContain("route=local-reason");
		expect(r.err).toContain("model=fixture-reason");
		expect(s.seen).toHaveLength(1);
		const hit = s.seen[0] as Seen;
		expect(hit.path).toBe("/v1/messages");
		expect(hit.hint).toBe("prefer local reasoning");
		const user = String(
			(hit.body.messages as { content: string }[])[0]?.content,
		);
		expect(user).toContain("Review this diff.");
		expect(user).toContain("VERDICT: PASS | VERDICT: FAIL - <reason>");
		// W832: stable finding IDs + cross-round ack contract ride the frame
		expect(user).toContain("B<round>-<slug>");
		expect(user).toContain("fixed | still-open | not-verifiable");
		expect(user).toContain("caps at blocker");
	} finally {
		s.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// c4 — model preference stays DATA: the ORACLE_ROUTE_MODEL pin wins, the
// "local-reason" default rides otherwise; NO discovery probe ever fires
test("model pin rides as data — ORACLE_ROUTE_MODEL, else local-reason, no probe", async () => {
	const s = makeStub("ok\nBUGS: none");
	try {
		const pinned = await run(["bugs"], {
			env: gateEnv(s, { ORACLE_ROUTE_MODEL: "pinned-reason" }),
			stdin: "for (let i = 0; i <= n; i++) {}\n",
		});
		expect(pinned.code).toBe(0);
		expect(pinned.err).toContain("model=pinned-reason");
		const unPinned = await run(["bugs"], {
			env: gateEnv(s),
			stdin: "for (let i = 0; i <= n; i++) {}\n",
		});
		expect(unPinned.code).toBe(0);
		expect(unPinned.err).toContain("model=local-reason");
		expect(s.seen).toHaveLength(2);
		for (const hit of s.seen) {
			expect(hit.path).toBe("/v1/messages");
			expect(hit.body.model).toBe(
				hit === s.seen[0] ? "pinned-reason" : "local-reason",
			);
		}
	} finally {
		s.stop();
	}
});

// c5 — bugs contract (stdin payload)
test("bugs frame carries the BUGS contract", async () => {
	const s = makeStub("x:1 — off-by-one — high\nBUGS: 1 found");
	try {
		const r = await run(["bugs"], {
			env: gateEnv(s),
			stdin: "for (let i = 0; i <= n; i++) {}\n",
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("BUGS: 1 found");
		const user = String(
			(s.seen[0].body.messages as { content: string }[])[0]?.content,
		);
		expect(user).toContain("Find bugs.");
		expect(user).toContain("BUGS: none | BUGS: <n> found");
		expect(user).toContain("i <= n");
	} finally {
		s.stop();
	}
});

// c6 — analyze verb: FOCUS from bare topic words; bare analyze (no input, no topic) errors
test("analyze builds FOCUS from topic words; bare analyze errors exit 1", async () => {
	const s = makeStub("WHAT: x\nHOW: - y\nRISKS: - z\nOPEN QUESTIONS: - q");
	const dir = mkdtempSync(join(tmpdir(), "oracle-w647-an-"));
	const file = join(dir, "note.md");
	writeFileSync(file, "the router classifies by keyword\n");
	try {
		const a = await run(["analyze", "--in", file, "token", "ring", "latency"], {
			env: gateEnv(s),
		});
		expect(a.code).toBe(0);
		const user = String(
			(s.seen[0].body.messages as { content: string }[])[0]?.content,
		);
		expect(user).toContain("Analyze this.");
		expect(user).toContain("FOCUS: token ring latency");
		expect(user).toContain("keyword");
	} finally {
		s.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// c7 — --cloud rides the SAME gate as the pinned leg: the stronger route is
// the W136 hint + the glm-5.3 default pin, never a separate wire
test("--cloud rides the shared gate with the prefer-cloud hint and glm-5.3", async () => {
	const s = makeStub("cloud findings\nVERDICT: STUBPASS");
	try {
		const r = await run(["review", "--cloud"], {
			env: gateEnv(s, { ORACLE_ROUTE_MODEL: "pinned-reason" }),
			stdin: "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n+cloud leg diff\n",
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("cloud findings");
		expect(r.err).toContain("route=cloud");
		expect(r.err).toContain("model=glm-5.3");
		expect(s.seen).toHaveLength(1);
		const hit = s.seen[0] as Seen;
		expect(hit.path).toBe("/v1/messages");
		expect(hit.hint).toBe("prefer cloud");
		expect(hit.body.model).toBe("glm-5.3");
	} finally {
		s.stop();
	}
});

// c8 — NO gate configured → honest exit 2 (fail closed, both legs)
test("no gate configured is an honest exit 2 on both legs", async () => {
	const home = mkdtempSync(join(tmpdir(), "oracle-w647-home-"));
	const r = await run(["review", "--cloud"], {
		unset: ["SUSPENDERS_BUCKLE_URL", "SUSPENDERS_BUCKLE_TOKEN"],
		home,
		stdin: "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n+x\n",
	});
	rmSync(home, { recursive: true, force: true });
	expect(r.code).toBe(2);
	// W1307: absent config fails at route resolution, before any fetch —
	// the honest exit-2 message is the distill-route one (stale expectation
	// proven at base 42b51034 via /tmp mirror A/B, not this branch's drift)
	expect(r.err).toContain("scoped Buckle distill route unavailable");
});

// c9 — statelessness, input discipline, unknown verb
test("stateless: two identical calls send byte-identical bodies", async () => {
	const s = makeStub("same\nVERDICT: STUBPASS");
	const dir = mkdtempSync(join(tmpdir(), "oracle-w647-sl-"));
	const file = join(dir, "d.diff");
	writeFileSync(file, "ctx\n");
	try {
		const args = ["review", "--in", file];
		const env = gateEnv(s);
		const r1 = await run(args, { env });
		const r2 = await run(args, { env });
		expect(r1.code).toBe(0);
		expect(r2.code).toBe(0);
		expect(s.seen).toHaveLength(2);
		const b1 = s.seen[0].body;
		const b2 = s.seen[1].body;
		expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
		expect(Object.keys(b1)).not.toContain("session");
	} finally {
		s.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no input (clean repo, no --in, no stdin) is exit 1", async () => {
	const s = makeStub("nope");
	const repo = gitDir(keep);
	try {
		const r = await run(["review", "--repo", repo], {
			env: gateEnv(s),
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("no input");
		expect(s.seen).toHaveLength(0);
	} finally {
		s.stop();
	}
});

// c10 — usage discipline: unknown verb, bare analyze
test("unknown verb and bare analyze both exit 1 with usage on stderr", async () => {
	const s = makeStub("nope");
	try {
		const u = await run(["nonsense"], {
			env: gateEnv(s),
		});
		expect(u.code).toBe(1);
		expect(u.err).toContain("usage: oracle");
		const b = await run(["analyze"], {
			env: gateEnv(s),
		});
		expect(b.code).toBe(1);
		expect(b.err).toContain("no input for analyze");
		expect(s.seen).toHaveLength(0);
	} finally {
		s.stop();
	}
});

test("W742.1 panel fans both legs through the ONE gate and marks agreement", async () => {
	const s = makeStub("", 200, [
		"Local read.\nVERDICT: approve",
		"Cloud read.\nVERDICT: hold - quota risk",
	]);
	const dir = mkdtempSync(join(tmpdir(), "oracle-panel-"));
	keep.push(dir);
	const q = join(dir, "q.md");
	await Bun.write(q, "Fork: retry verb placement?");
	try {
		const r = await run(["panel", "--in", q, "--timeout-secs", "10"], {
			env: gateEnv(s, { ORACLE_ROUTE_MODEL: "panel-reason" }),
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("APPROVE");
		expect(r.out).toContain("HOLD");
		expect(r.out).toContain("split");
		expect(r.out).toContain("panel: split");
		// both legs rode the same gate: pinned model pin first, cloud pin second
		expect(s.seen).toHaveLength(2);
		expect(s.seen[0]?.path).toBe("/v1/messages");
		expect(s.seen[0]?.body.model).toBe("panel-reason");
		expect(s.seen[1]?.body.model).toBe("glm-5.3");
	} finally {
		s.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// W1307 — the cloud-leg empty failure names the budget lever: upstream burned
// the whole max_tokens budget on reasoning before any text block
test("cloud empty text with stop_reason=max_tokens names the max-tokens lever", async () => {
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			Response.json({
				content: [],
				stop_reason: "max_tokens",
				model: "glm-5.3",
				usage: { input_tokens: 12, output_tokens: 1500 },
			}),
	});
	try {
		const r = await run(["analyze", "--cloud", "budget probe"], {
			env: {
				SUSPENDERS_BUCKLE_URL: `http://127.0.0.1:${srv.port}`,
				SUSPENDERS_BUCKLE_TOKEN: "bksk_fixt",
			},
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain("stop_reason=max_tokens");
		expect(r.err).toContain("--max-tokens");
	} finally {
		srv.stop(true);
	}
});

// W1307 — the cloud leg honors the caller's wall-clock budget: before, the
// leg dropped --timeout-secs and buckleChat's 120s default aborted long
// reviews mid-flight. A slow upstream + a 2s budget must fail fast (exit 2),
// not hang to the 120s default.
test("cloud leg aborts on the caller's --timeout-secs, not the client default", async () => {
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async () => {
			await Bun.sleep(15_000);
			return Response.json({
				content: [{ type: "text", text: "too late\nVERDICT: STUBPASS" }],
			});
		},
	});
	try {
		const t0 = Date.now();
		const r = await run(
			["analyze", "--cloud", "--timeout-secs", "2", "slow probe"],
			{
				env: {
					SUSPENDERS_BUCKLE_URL: `http://127.0.0.1:${srv.port}`,
					SUSPENDERS_BUCKLE_TOKEN: "bksk_fixt",
				},
			},
		);
		const wall = Date.now() - t0;
		expect(r.code).toBe(2);
		expect(r.err).toContain("buckle inference unavailable");
		expect(wall).toBeLessThan(10_000);
	} finally {
		srv.stop(true);
	}
});

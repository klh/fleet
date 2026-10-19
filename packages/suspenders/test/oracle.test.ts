// oracle.test.ts — W647: the named review/escalation tool. Contract pins:
// the three fixed frames ride as the user message (review's VERDICT line
// matches review-lane.ts's parse), the default leg hits EXACTLY
// ORACLE_ROUTE_URL (pinned, never router-classified), --cloud rides the
// :4000 router's escalation leg and never the pinned leg, --cloud without a
// configured leg is an honest exit 2, and the call is stateless (two calls,
// byte-identical request bodies).
import { afterAll, setDefaultTimeout, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const ORACLE = join(import.meta.dir, "..", "hooks", "bin", "oracle.ts");

type Seen = { path: string; key: string | null; body: Record<string, unknown> };

// one stub answers both wires: /v1/messages → anthropic, else OpenAI chat
function makeStub(content: string, status = 200) {
	const seen: Seen[] = [];
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			seen.push({
				path: url.pathname,
				key: req.headers.get("x-api-key"),
				body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
			});
			const reply = url.pathname.endsWith("/v1/messages")
				? { content: [{ text: content }] }
				: { choices: [{ message: { content } }] };
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

// c2 — spawn + git helpers for the oracle suite (spliced into oracle.test.ts)
const keep: string[] = [];
afterAll(() => {
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
test("review pins the fixed frame + payload to the configured route", async () => {
	const s = makeStub("looks fine\nVERDICT: STUBPASS");
	const dir = mkdtempSync(join(tmpdir(), "oracle-w647-"));
	const file = join(dir, "d.diff");
	writeFileSync(file, "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n");
	try {
		const r = await run(["review", "--in", file], {
			env: { ORACLE_ROUTE_URL: s.chat, ORACLE_ROUTE_MODEL: "fixture-reason" },
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("VERDICT: STUBPASS");
		expect(r.err).toContain("route=local-reason");
		expect(s.seen).toHaveLength(1);
		const hit = s.seen[0] as Seen;
		expect(hit.path).toBe("/v1/chat/completions");
		const user = String(
			(hit.body.messages as { content: string }[])[1]?.content,
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

// c4 — model probe + bugs contract
test("model id is probed from /models when ORACLE_ROUTE_MODEL is unset", async () => {
	let probed = false;
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/v1/models") {
				probed = true;
				return Response.json({ data: [{ id: "probed-reason" }] });
			}
			const body = (await req.json()) as { model: string };
			expect(body.model).toBe("probed-reason");
			return Response.json({
				choices: [{ message: { content: "ok\nBUGS: none" } }],
			});
		},
	});
	try {
		const r = await run(["bugs"], {
			env: {
				ORACLE_ROUTE_URL: `http://127.0.0.1:${srv.port}/v1/chat/completions`,
			},
			stdin: "for (let i = 0; i <= n; i++) {}\n",
		});
		expect(r.code).toBe(0);
		expect(probed).toBe(true);
		expect(r.err).toContain("model=probed-reason");
	} finally {
		srv.stop(true);
	}
});

// c5 — bugs contract (stdin payload)
test("bugs frame carries the BUGS contract", async () => {
	const s = makeStub("x:1 — off-by-one — high\nBUGS: 1 found");
	try {
		const r = await run(["bugs"], {
			env: { ORACLE_ROUTE_URL: s.chat, ORACLE_ROUTE_MODEL: "m" },
			stdin: "for (let i = 0; i <= n; i++) {}\n",
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("BUGS: 1 found");
		const user = String(
			(s.seen[0].body.messages as { content: string }[])[1]?.content,
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
			env: { ORACLE_ROUTE_URL: s.chat, ORACLE_ROUTE_MODEL: "m" },
		});
		expect(a.code).toBe(0);
		const user = String(
			(s.seen[0].body.messages as { content: string }[])[1]?.content,
		);
		expect(user).toContain("Analyze this.");
		expect(user).toContain("FOCUS: token ring latency");
		expect(user).toContain("keyword");
	} finally {
		s.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// c7 — --cloud rides the escalation leg, never the pinned leg
test("--cloud rides the :4000 router escalation leg (anthropic wire, glm-5.3)", async () => {
	const local = makeStub("SHOULD NOT BE CALLED");
	const s = makeStub("cloud findings\nVERDICT: STUBPASS");
	try {
		const r = await run(["review", "--cloud"], {
			env: {
				ORACLE_ROUTE_URL: local.chat,
				BELT_ESCALATE_URL: s.base,
				BELT_ESCALATE_KEY: "bksk_fixt",
			},
			stdin: "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n+cloud leg diff\n",
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("cloud findings");
		expect(r.err).toContain("route=cloud");
		expect(local.seen).toHaveLength(0);
		expect(s.seen).toHaveLength(1);
		const hit = s.seen[0] as Seen;
		expect(hit.path).toBe("/v1/messages");
		expect(hit.key).toBe("bksk_fixt");
		expect(hit.body.model).toBe("glm-5.3");
	} finally {
		local.stop();
		s.stop();
	}
});

// c8 — --cloud with NO configured leg → honest exit 2 (never the pinned leg)
test("--cloud with no leg configured is an honest exit 2", async () => {
	const local = makeStub("SHOULD NOT BE CALLED");
	const home = mkdtempSync(join(tmpdir(), "oracle-w647-home-"));
	const r = await run(["review", "--cloud"], {
		env: { ORACLE_ROUTE_URL: local.chat, ORACLE_ROUTE_MODEL: "m" },
		unset: ["BELT_ESCALATE_URL", "BELT_ESCALATE_KEY"],
		home,
		stdin: "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n+x\n",
	});
	local.stop();
	rmSync(home, { recursive: true, force: true });
	expect(r.code).toBe(2);
	expect(r.err).toContain("no cloud leg configured");
	expect(local.seen).toHaveLength(0);
});

// c9 — statelessness, input discipline, unknown verb
test("stateless: two identical calls send byte-identical bodies", async () => {
	const s = makeStub("same\nVERDICT: STUBPASS");
	const dir = mkdtempSync(join(tmpdir(), "oracle-w647-sl-"));
	const file = join(dir, "d.diff");
	writeFileSync(file, "ctx\n");
	try {
		const args = ["review", "--in", file];
		const env = { ORACLE_ROUTE_URL: s.chat, ORACLE_ROUTE_MODEL: "m" };
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
			env: { ORACLE_ROUTE_URL: s.chat, ORACLE_ROUTE_MODEL: "m" },
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
			env: { ORACLE_ROUTE_URL: s.chat },
		});
		expect(u.code).toBe(1);
		expect(u.err).toContain("usage: oracle");
		const b = await run(["analyze"], {
			env: { ORACLE_ROUTE_URL: s.chat },
		});
		expect(b.code).toBe(1);
		expect(b.err).toContain("no input for analyze");
		expect(s.seen).toHaveLength(0);
	} finally {
		s.stop();
	}
});

test("W742.1 panel fans to both legs and marks agreement", async () => {
	const local = makeStub("Local read.\nVERDICT: approve");
	const cloud = makeStub("Cloud read.\nVERDICT: hold - quota risk");
	const dir = mkdtempSync(join(tmpdir(), "oracle-panel-"));
	keep.push(dir);
	const q = join(dir, "q.md");
	await Bun.write(q, "Fork: retry verb placement?");
	try {
		const r = await run(["panel", "--in", q, "--timeout-secs", "10"], {
			env: {
				ORACLE_ROUTE_URL: local.chat,
				BELT_ESCALATE_URL: `${cloud.base}/v1/messages`,
				BELT_ESCALATE_KEY: "k",
			},
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("APPROVE");
		expect(r.out).toContain("HOLD");
		expect(r.out).toContain("split");
		expect(r.out).toContain("panel: split");
	} finally {
		local.stop();
		cloud.stop();
	}
});

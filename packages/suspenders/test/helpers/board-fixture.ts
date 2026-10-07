// test/helpers/board-fixture.ts — the fleet-board test fixture (W157
// split). boardFixture(port, afterAll) builds a scratch HOME/repo/git +
// one board on the given port and returns the shared helpers; every
// test file awaits its own instance via top-level await, so hooks stay
// bound to the importing file. Bodies moved verbatim from
// fleet-board.test.ts lines 22-157.
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// rows off the board's JSON feeds — Record<string, unknown> keeps the feed
// callbacks honest without modeling every endpoint (the wire data is
// untrusted until the assertion pins it)
type Row = Record<string, unknown>;

// Let the OS choose an unused loopback port; fixed test ports can silently
// attach to a board left by another run and use its unrelated write token.
export function unusedPort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = server.port;
	server.stop(true);
	return port;
}

export async function boardFixture(
	PORT: number,
	afterAll: (fn: () => void | Promise<void>) => void,
): Promise<{
	TOKEN;
	HOME;
	REPO;
	GREPO;
	env;
	bin;
	PORT;
	BASE;
	run;
	q;
	sleep;
	getData;
	MY_PROJ;
	myProject;
	getDecisions;
	post;
	rawPost;
	fork;
	addWork;
	waitUp;
	proc;
	setDemoProc;
}> {
	const HOME = mkdtempSync(join(tmpdir(), "suspenders-board-"));
	const REPO = mkdtempSync(join(tmpdir(), "suspenders-boardrepo-"));
	mkdirSync(join(REPO, ".git"), { recursive: true });
	// W55: a REAL git repo for the diff endpoint (REPO's .git is an empty dir)
	const GREPO = mkdtempSync(join(tmpdir(), "suspenders-boardgit-"));
	// fixture hygiene: the harness's lane identity (SUSPENDERS_SID +
	// canonical-v1 protocol) must not leak into spawned hooks — the
	// declared-lane gate refuses the test's own sid — and the live buckle
	// front + real belt.env would let an enrollment mint real keys
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME,
		SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
		SUSPENDERS_MDNS: "0",
		SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
		SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
		SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
		SUSPENDERS_BELT_ENV: join(HOME, "absent-belt.env"),
	};
	delete env.SUSPENDERS_SID;
	delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
	if (PORT === 0) PORT = unusedPort();
	const bin = join(import.meta.dir, "..", "..", "hooks", "bin");
	const BASE = `http://127.0.0.1:${PORT}`;

	function run(cmd: string, args: string[]) {
		const p = Bun.spawnSync(["bun", join(bin, cmd), ...args], {
			cwd: REPO,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString(),
			err: p.stderr.toString(),
			code: p.exitCode,
		};
	}
	const q = (s: string) => encodeURIComponent(s);

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	async function getData() {
		const r = await fetch(`${BASE}/api/data`);
		return r.json();
	}
	// board() lists EVERY partition — the module-scope --demo board shares this
	// DB and its partition may sort before ours (platform-dependent), so tests
	// must select their own project, never projects[0]
	const MY_PROJ = realpathSync(REPO);
	async function myProject() {
		const d = await getData();
		return d.projects.find((p: Row) => p.project === MY_PROJ);
	}
	async function getDecisions() {
		// v3 default is OPEN-only (docs/board-api.md) — the lifecycle tests below
		// also read resolved rows, so they ride the history view
		return (await fetch(`${BASE}/api/decisions?history=1`)).json();
	}
	async function post(
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	) {
		const r = await fetch(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": TOKEN,
				...headers,
			},
			body: JSON.stringify(body),
		});
		return { status: r.status, json: await r.json() };
	}
	// fetch() refuses to set Host/Origin — raw node:http for the hostile cases
	function rawPost(
		headers: Record<string, string>,
		body: string,
		{ method = "POST", path = "/api/ack" } = {},
	): Promise<{ status: number | undefined; body: string }> {
		return new Promise((resolve) => {
			const rq = httpRequest(
				{
					host: "127.0.0.1",
					port: PORT,
					path,
					method,
					headers,
				},
				(res) => {
					let b = "";
					res.on("data", (c) => (b += c));
					res.on("end", () => resolve({ status: res.statusCode, body: b }));
				},
			);
			rq.end(body);
		});
	}
	function fork(feed: { decisions: Row[] }, question: string) {
		const hits = feed.decisions.filter((d: Row) => d.question === question);
		expect(hits.length).toBeLessThanOrEqual(1); // questions unique per test
		return hits[0];
	}
	// work add with a dynamic id — never hard-code W-numbers, the sequence shifts
	function addWork(title: string, args: string[] = []): string {
		const r = run("work.ts", ["add", title, ...args]);
		if (r.code !== 0) throw new Error(`work add failed: ${r.err}`);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, {
			readonly: true,
		});
		const row = db
			.query("SELECT id FROM work_items WHERE title = ?")
			.get(title) as { id: string };
		db.close();
		return row.id;
	}

	const proc = Bun.spawn(
		["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	// Register cleanup before awaiting startup so failed fixtures cannot leak
	// processes. Drain output continuously to avoid a full pipe blocking them.
	let output = "";
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream)
			output = `${output}${new TextDecoder().decode(chunk)}`.slice(-16_384);
	};
	void drain(proc.stdout);
	void drain(proc.stderr);
	// second instance for --demo seeding (same temp HOME — the demo partition
	// lives in its governor.db, never in a real project)
	let demoProc: Bun.Subprocess | null = null;
	function setDemoProc(p: Bun.Subprocess | null): void {
		demoProc = p;
	}
	async function waitUp(base: string) {
		for (let i = 0; i < 100; i++) {
			try {
				if (
					(
						await fetch(`${base}/api/data`, {
							signal: AbortSignal.timeout(500),
						})
					).ok
				)
					return;
			} catch {}
			await sleep(100);
		}
		throw new Error(`fleet board did not start on ${base}: ${output}`);
	}
	afterAll(async () => {
		proc.kill();
		await proc.exited;
		if (demoProc) {
			demoProc.kill();
			await demoProc.exited;
		}
		rmSync(HOME, { recursive: true, force: true });
		rmSync(REPO, { recursive: true, force: true });
		rmSync(GREPO, { recursive: true, force: true });
	});
	await waitUp(BASE);
	// W264: the board mints its per-install write token at start (temp HOME)
	const TOKEN = readFileSync(
		`${HOME}/.cache/claude-governor/write-token`,
		"utf8",
	).trim();
	return {
		TOKEN,
		HOME,
		REPO,
		GREPO,
		env,
		bin,
		PORT,
		BASE,
		run,
		q,
		sleep,
		getData,
		MY_PROJ,
		myProject,
		getDecisions,
		post,
		rawPost,
		fork,
		addWork,
		waitUp,
		proc,
		setDemoProc,
	};
}

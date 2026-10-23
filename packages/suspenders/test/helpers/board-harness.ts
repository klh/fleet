// test/helpers/board-harness.ts — W1135.1.6: the ONE shared board harness
// (moved verbatim from e2e/harness.ts, which this file replaces). A scratch
// HOME + repo per board, a REAL fleet-board.ts on an OS-picked loopback port,
// and the work CLI run against the same scratch HOME (→ the very governor.db
// the board serves). Runtime-neutral on purpose: NO bun:test and NO
// @playwright/test imports — the e2e (playwright) and unit (bun:test) sides
// both import it, and helpers only throw plain Errors. The hub world and the
// local world share NOTHING — separate scratch HOMEs are the structural
// scope isolation the GUI test proves.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorkResult {
	code: number;
	out: string;
	err: string;
}

export interface Board {
	/** e.g. http://127.0.0.1:PORT */
	BASE: string;
	/** the board's scratch HOME — its governor.db and identity live here */
	HOME: string;
	/** the board's one project = the scratch repo realpath */
	MY_PROJ: string;
	/** what the board's project column shortens it to */
	projShort: string;
	/** run the work CLI against this board's graph */
	work(args: string[]): WorkResult;
	/** work() + exit-code 0 expected; returns stdout */
	workOk(args: string[], why: string): string;
	/** the id a fresh `work add` minted (parsed from its stdout) */
	mintedId(out: string): string;
	stop(): Promise<void>;
}

/** Bind :0, read the OS-picked port, release. */
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

/**
 * 100×100ms readiness poll — the ONE wait-up idiom (bind :0 + poll /api/data
 * until ok, else throw with the drained child output).
 */
export async function waitUp(
	base: string,
	what: string,
	out: () => string,
): Promise<void> {
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
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`${what} did not start: ${out()}`);
}

/** Spawn the REAL fleet-board.ts child (drained, never pipe-blocked) and
 * return its process + the readiness poll bound to its output. */
function spawnBoard(
	label: string,
	PORT: number,
	REPO: string,
	env: NodeJS.ProcessEnv,
	bin: string,
	args?: string[],
): { proc: Bun.Subprocess; waitUp: (base: string) => Promise<void> } {
	const proc = Bun.spawn(
		[
			"bun",
			join(bin, "fleet-board.ts"),
			"--port",
			String(PORT),
			...(args ?? []),
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	let output = "";
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream)
			output = `${output}${new TextDecoder().decode(chunk)}`.slice(-16_384);
	};
	void drain(proc.stdout);
	void drain(proc.stderr);
	return {
		proc,
		waitUp: (base: string) => waitUp(base, `board ${label}`, () => output),
	};
}

/** Kill the board child and rm the scratch world it served. */
async function boardStop(proc: Bun.Subprocess, dirs: string[]): Promise<void> {
	proc.kill();
	await proc.exited;
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The dead-upstream scratch env every board start pins (caller may override). */
function boardEnv(
	HOME: string,
	extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME,
		SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
		SUSPENDERS_MDNS: "0",
		SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
		SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
		...extra,
	};
}

export async function startBoard(
	label: string,
	opts: { env?: NodeJS.ProcessEnv; args?: string[] } = {},
): Promise<Board> {
	const HOME = mkdtempSync(join(tmpdir(), `sb-e2e-${label}-home-`));
	const REPO = mkdtempSync(join(tmpdir(), `sb-e2e-${label}-repo-`));
	mkdirSync(join(REPO, ".git"), { recursive: true });
	const PORT = unusedPort();
	const env = boardEnv(HOME, opts.env);
	const bin = join(import.meta.dir, "..", "..", "hooks", "bin");
	const BASE = `http://127.0.0.1:${String(PORT)}`;
	const runner = makeWork(bin, REPO, env);
	const { proc, waitUp } = spawnBoard(label, PORT, REPO, env, bin, opts.args);
	await waitUp(BASE);
	const real = realpathSync(HOME);
	return {
		BASE,
		HOME: real,
		MY_PROJ: realpathSync(REPO),
		projShort: realpathSync(REPO).split("/").pop() ?? REPO,
		work: runner.work,
		workOk: runner.workOk,
		mintedId: runner.mintedId,
		stop: async () => {
			await boardStop(proc, [HOME, REPO]);
		},
	};
}

/** The work CLI against the board's own scratch HOME (→ its governor.db). */
function makeWork(
	bin: string,
	REPO: string,
	env: NodeJS.ProcessEnv,
): {
	work(args: string[]): WorkResult;
	workOk(args: string[], why: string): string;
	mintedId(out: string): string;
} {
	function work(args: string[]): WorkResult {
		const p = Bun.spawnSync(["bun", join(bin, "work.ts"), ...args], {
			cwd: REPO,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	}
	function workOk(args: string[], why: string): string {
		const r = work(args);
		if (r.code !== 0) {
			throw new Error(`${why}: ${r.err || r.out}`);
		}
		return r.out;
	}
	// `✓ W1 READY — <title>` — first W-number on stdout
	function mintedId(out: string): string {
		const m = /\b(W\d+)\b/.exec(out);
		if (m === null) {
			throw new Error(`no work id in: ${out}`);
		}
		return m[1];
	}
	return { work, workOk, mintedId };
}

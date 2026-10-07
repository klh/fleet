// e2e/harness.ts — W353: the two-board harness for the hub-board GUI e2e.
// Mirrors test/helpers/board-fixture.ts: a scratch HOME + repo per board, a
// REAL fleet-board.ts on an OS-picked loopback port, and the work CLI run
// against the same scratch HOME (→ the very governor.db the board serves).
// The hub world and the local world share NOTHING — separate scratch HOMEs
// are the structural scope isolation the GUI test proves.
import { expect } from "@playwright/test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
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

export async function startBoard(label: string): Promise<Board> {
	const HOME = mkdtempSync(join(tmpdir(), `sb-e2e-${label}-home-`));
	const REPO = mkdtempSync(join(tmpdir(), `sb-e2e-${label}-repo-`));
	mkdirSync(join(REPO, ".git"), { recursive: true });
	const PORT = unusedPort();
	// dead loopback upstreams like the bun fixture — the board degrades
	// honestly instead of reaching the machine's real services
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME,
		SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
		SUSPENDERS_MDNS: "0",
		SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
		SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
	};
	const bin = join(import.meta.dir, "..", "hooks", "bin");
	const BASE = `http://127.0.0.1:${String(PORT)}`;

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
		expect(r.code, `${why}: ${r.err || r.out}`).toBe(0);
		return r.out;
	}
	// `✓ W1 READY — <title>` — first W-number on stdout
	function mintedId(out: string): string {
		const m = /\b(W\d+)\b/.exec(out);
		expect(m, `no work id in: ${out}`).not.toBeNull();
		const id = m?.[1];
		if (id === undefined) throw new Error(`no work id in: ${out}`);
		return id;
	}

	const proc = Bun.spawn(
		["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	let output = "";
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream)
			output = `${output}${new TextDecoder().decode(chunk)}`.slice(-16_384);
	};
	void drain(proc.stdout);
	void drain(proc.stderr);
	async function waitUp() {
		for (let i = 0; i < 100; i++) {
			try {
				if (
					(
						await fetch(`${BASE}/api/data`, {
							signal: AbortSignal.timeout(500),
						})
					).ok
				)
					return;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`board ${label} did not start: ${output}`);
	}
	await waitUp();

	return {
		BASE,
		MY_PROJ: realpathSync(REPO),
		projShort: realpathSync(REPO).split("/").pop() ?? REPO,
		work,
		workOk,
		mintedId,
		stop: async () => {
			proc.kill();
			await proc.exited;
			rmSync(HOME, { recursive: true, force: true });
			rmSync(REPO, { recursive: true, force: true });
		},
	};
}

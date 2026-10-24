// fleet-loop/runtime.ts — the loop's shared runtime helpers bound to the
// parsed config (W740 split): logging, git shells, the lane registry view,
// and the 3-strike fail tracker. Downstream modules take these as deps.

import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { loadLaneRegistry } from "../lanes/lane-registry.ts";
import type { LoopConfig } from "./config.ts";
export type Lane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
	agent?: string;
	launchedAt?: number;
	host?: string;
};

export function readJsonSync<T>(p: string): T | null {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
}

export type LoopDeps = {
	REPO: string;
	log: (msg: string) => void;
	sh: (cmd: string[]) => string;
	run: (cmd: string[]) => number;
	runCap: (cmd: string[]) => { code: number; out: string };
	lanes: () => Lane[];
	bumpFail: (b: string) => number;
	clearFail: (b: string) => void;
	ahead: (b: string) => number;
};

export function createRuntime(config: LoopConfig): LoopDeps {
	const { REPO, LOG, FAILS, MAIN } = config;
	const log = (msg: string): void => {
		const line = `${new Date().toISOString()} ${msg}\n`;
		try {
			appendFileSync(LOG, line);
		} catch {
			try {
				mkdirSync(LOG.replace(/\/[^/]+$/, ""), { recursive: true });
				appendFileSync(LOG, line);
			} catch {}
		}
	};

	const sh = (cmd: string[]): string => {
		const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
	};
	const run = (cmd: string[]): number =>
		Bun.spawnSync(cmd, { cwd: REPO, stdout: "ignore", stderr: "ignore" })
			.exitCode ?? 1;

	const lanes = (): Lane[] => loadLaneRegistry<Lane>(REPO);
	const readFails = (): Record<string, number> => readJsonSync(FAILS) ?? {};
	const writeFails = (o: Record<string, number>): void => {
		try {
			writeFileSync(FAILS, JSON.stringify(o));
		} catch {}
	};
	const bumpFail = (b: string): number => {
		const o = readFails();
		o[b] = (o[b] ?? 0) + 1;
		writeFails(o);
		return o[b];
	};
	const clearFail = (b: string): void => {
		const o = readFails();
		if (o[b] === undefined) return;
		delete o[b];
		writeFails(o);
	};

	const ahead = (b: string): number => {
		// a failed rev-list (unknown ref, park-rename race) must read as
		// UNMERGED, never as merged — Number("") was 0, which made any vanished
		// branch look fully merged to the retire path (2026-09-28 gaps losses)
		const out = sh(["git", "rev-list", "--count", `${MAIN}..${b}`]);
		const n = Number(out);
		return out !== "" && Number.isFinite(n) ? n : -1;
	};

	// retire's runs capture stderr — a RETIRE-BLOCKED line must carry git's
	// reason (the loop's own "reasonless FAIL is a bug" doctrine)
	const runCap = (cmd: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
		};
	};
	return { REPO, log, sh, run, runCap, lanes, bumpFail, clearFail, ahead };
}

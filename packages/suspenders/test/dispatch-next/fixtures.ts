// fixtures — shared scratch HOME/REPO graph, spawn helpers, buckle stub.
// Registered first: module-level setup runs before any test module imports.

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HOME,
	REPO,
	BIN,
	env,
	testExecutor,
	g,
	toolWith,
	tool,
	dispatchWith,
	dispatch,
	stubBuckle,
	toolA,
	dispatchA,
	addItem,
	addId,
	showState,
	pokeStale,
	sleeperExecutor,
	killPids,
} from "./fixtures.ts";

export const HOME = mkdtempSync(join(tmpdir(), "claude-w145-dispatch-home-"));
export const REPO = realpathSync(
	mkdtempSync(join(tmpdir(), "suspenders-w145-dispatch-repo-")),
);
export const BIN = join(import.meta.dir, "..", "..", "hooks", "bin");
// W463: pin the buckle front to a dead port for the legacy cases — probe
// misses = belt-direct note path (pre-W463 behavior), deterministic even on
// a machine with a live spoke on :4101. Fail-closed refusal/override get
// their own stub-front cases below.
export const testExecutor = join(HOME, "test-claude");
writeFileSync(testExecutor, "#!/bin/sh\nexit 0\n");
chmodSync(testExecutor, 0o700);
export const env = {
	SUSPENDERS_CLAUDE_BIN: testExecutor,
	...process.env,
	HOME,
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	// W670: the resume-budget fixtures assume the default attempt cap — pin
	// it so an ambient SUSPENDERS_LANE_MAX_ATTEMPTS (the operator quarantine
	// unblock knob) cannot leak through ...process.env and move the threshold.
	SUSPENDERS_LANE_MAX_ATTEMPTS: "3",
};

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: one commit so worktree ops would have a base

export const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);


writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

export const toolWith = (
	extra: Record<string, string | undefined>,
	bin: string,
	...args: string[]
) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};
export const tool = (bin: string, ...args: string[]) => toolWith({}, bin, ...args);
export const dispatchWith = (
	extra: Record<string, string | undefined>,
	...args: string[]
) => {
	// dispatch-next lives in scripts/, not hooks/bin — spawn it directly
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "..", "scripts", "dispatch-next.ts"),
			"--repo",
			REPO,
			...args,
		],
		{ cwd: REPO, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};
export const dispatch = (...args: string[]) => dispatchWith({}, ...args);

// ─── W463 fail-closed governance + lane key lifecycle ──────────────────────
// NOTE: e2e cases here spawn dispatch-next/worktree async (Bun.spawn, not
// spawnSync): a sync spawn blocks this process' event loop, which would stall
// the stub buckle front and make the child's 600ms front probe time out.

export const stubBuckle = (
	mint = false,
): {
	port: number;
	calls: string[];
	stop: () => void;
} => {
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			calls.push(`${req.method} ${path}`);
			if (path === "/status") return new Response("ok");
			if (path === "/v1/admin/keys" && mint)
				return Response.json({ key: "bksk_fixture_only", key_id: "owned-key" });
			if (path === "/v1/admin/keys")
				return new Response(JSON.stringify({ error: "stub-mint-fail" }), {
					status: 500,
				});
			if (path.endsWith("/revoke"))
				return new Response(JSON.stringify({ revoked: "ok" }));
			return new Response("not found", { status: 404 });
		},
	});
	return { port: server.port, calls, stop: () => server.stop(true) };
};

// scratch belt.env with an admin key — the mint CALL fails at the stub, which
// is the W463 defect scenario (front up, governance mint broken)
writeFileSync(join(HOME, "belt.env"), "BUCKLE_ADMIN_KEY=bksk_admin_scratch\n");

export const toolA = async (
	extra: Record<string, string | undefined>,
	bin: string,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const p = Bun.spawn([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	return { out, err, code };
};

export const dispatchA = async (
	extra: Record<string, string | undefined>,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const cmd = [
		process.execPath,
		join(import.meta.dir, "..", "..", "scripts", "dispatch-next.ts"),
		"--repo",
		REPO,
		...args,
	];
	const p = Bun.spawn(cmd, {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	return { out, err, code };
};

export const addItem = async (title: string): Promise<string> => {
	const added = await toolA({}, "work.ts", "add", title);
	const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
	expect(id).toBeTruthy();
	return id;
};

export const addId = (title: string): string =>
	(tool("work.ts", "add", title).out.match(/W\d+/) ?? [])[0] ?? "";

export const showState = async (
	id: string,
): Promise<{ state: string }> =>
	JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out);

export const pokeStale = (id: string): void => {
	const row = JSON.parse(tool("work.ts", "show", id, "--json").out) as {
		project: string;
	};
	const db = new Database(
		join(HOME, ".cache", "claude-governor", "governor.db"),
	);
	db.run(
		"UPDATE work_items SET updated_at = 1 WHERE project = ? AND id = ?",
		[row.project, id],
	);
	db.close();
};

export const sleeperExecutor = (path: string, body: string): string => {
	writeFileSync(path, body);
	chmodSync(path, 0o700);
	return path;
};

export const killPids = (pidFile: string): void => {
	if (!existsSync(pidFile)) return;
	for (const pid of readFileSync(pidFile, "utf8").trim().split("\n")) {
		try {
			process.kill(Number(pid));
		} catch {}
	}
};

// test/helpers/dispatch-harness.ts — the ONE dispatch-test harness
// (W695.8.7.1). dispatchHarness(afterAll, opts) builds the scratch HOME +
// repo, the no-op executor, the dead-front env pins, the git helper and the
// tool/dispatch spawn helpers the dispatch suites share; stubBuckle() is the
// stub buckle front. One source of truth — the inline copies in
// dispatch-next.test.ts / dispatch-worktree-verify.test.ts /
// dispatch-hub-e2e.test.ts collapsed into this fixture (bodies moved
// verbatim, board-fixture convention). W670: fixture knobs (executor pin,
// dead front, attempt cap) are pinned AFTER ...process.env so ambient
// operator env cannot leak into spawns.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ToolResult = { out: string; err: string; code: number };

export type DispatchHarness = {
	HOME: string;
	REPO: string;
	BIN: string;
	executor: string;
	env: Record<string, string | undefined>;
	g: (args: string[]) => void;
	toolWith: (
		extra: Record<string, string | undefined>,
		bin: string,
		...args: string[]
	) => ToolResult;
	tool: (bin: string, ...args: string[]) => ToolResult;
	dispatchWith: (
		extra: Record<string, string | undefined>,
		...args: string[]
	) => ToolResult;
	dispatch: (...args: string[]) => ToolResult;
	toolA: (
		extra: Record<string, string | undefined>,
		bin: string,
		...args: string[]
	) => Promise<ToolResult>;
	dispatchA: (
		extra: Record<string, string | undefined>,
		...args: string[]
	) => Promise<ToolResult>;
	addItem: (title: string) => Promise<string>;
	cleanup: () => void;
};

/** The stub buckle front: /status ok, admin mint (500 unless `mint`),
 * revoke ok — bodies verbatim from dispatch-next.test.ts W463. */
export const stubBuckle = (
	mint = false,
): { port: number; calls: string[]; stop: () => void } => {
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

export const dispatchHarness = (
	afterAll: (fn: () => void | Promise<void>) => void,
	opts: {
		/** unique scratch prefix fragment, e.g. "w349-dispatch" */
		tag: string;
		/** executor script body; default is an immediate no-op */
		executorBody?: string;
		/** write $HOME/belt.env with the scratch admin key (mint scenarios) */
		beltEnv?: boolean;
		/** last-word env additions/strips over the pinned base */
		envOverrides?: (paths: {
			HOME: string;
			REPO: string;
		}) => Record<string, string | undefined>;
	} = { tag: "dispatch" },
): DispatchHarness => {
	const HOME = mkdtempSync(join(tmpdir(), `claude-${opts.tag}-home-`));
	const REPO = realpathSync(
		mkdtempSync(join(tmpdir(), `suspenders-${opts.tag}-repo-`)),
	);
	const BIN = join(import.meta.dir, "..", "..", "hooks", "bin");
	const executor = join(HOME, "test-claude");
	writeFileSync(executor, opts.executorBody ?? "#!/bin/sh\nexit 0\n");
	chmodSync(executor, 0o700);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME,
		SUSPENDERS_CLAUDE_BIN: executor,
		SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
		// W670: pin the attempt cap so an ambient SUSPENDERS_LANE_MAX_ATTEMPTS
		// (the operator quarantine knob) cannot move the resume thresholds.
		SUSPENDERS_LANE_MAX_ATTEMPTS: "3",
		// W768: the starter flag is default-ON in production — stub executors
		// can't seed, so fixture dispatches pin it off; starter suites opt in.
		SUSPENDERS_LANE_STARTER: "off",
		// W1294 sweep ports: playwright workers run with FORCE_COLOR=1, and the
		// spread leaks it into `bun -e` children whose stdout the suites parse
		// verbatim (bun ANSI-wraps console.log(null|false|numbers) under it).
		FORCE_COLOR: "0",
		...(opts.envOverrides?.({ HOME, REPO }) ?? {}),
	};

	mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
	symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

	if (opts.beltEnv)
		writeFileSync(
			join(HOME, "belt.env"),
			"BUCKLE_ADMIN_KEY=bksk_admin_scratch\n",
		);

	// scratch repo: one commit so worktree ops have a base
	const g = (args: string[]): void => {
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

	afterAll(() => {
		rmSync(HOME, { recursive: true, force: true });
		rmSync(REPO, { recursive: true, force: true });
	});

	const toolWith = (
		extra: Record<string, string | undefined>,
		bin: string,
		...args: string[]
	): ToolResult => {
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
	const tool = (bin: string, ...args: string[]): ToolResult =>
		toolWith({}, bin, ...args);

	const dispatchWith = (
		extra: Record<string, string | undefined>,
		...args: string[]
	): ToolResult => {
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
	const dispatch = (...args: string[]): ToolResult => dispatchWith({}, ...args);

	const toolA = async (
		extra: Record<string, string | undefined>,
		bin: string,
		...args: string[]
	): Promise<ToolResult> => {
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
		return { out, err, code: await p.exited };
	};

	const dispatchA = async (
		extra: Record<string, string | undefined>,
		...args: string[]
	): Promise<ToolResult> => {
		const p = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "..", "..", "scripts", "dispatch-next.ts"),
				"--repo",
				REPO,
				...args,
			],
			{ cwd: REPO, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
		);
		const [out, err] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		return { out, err, code: await p.exited };
	};

	const addItem = async (title: string): Promise<string> => {
		const added = await toolA({}, "work.ts", "add", title);
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		return id;
	};

	return {
		HOME,
		REPO,
		BIN,
		executor,
		env,
		g,
		toolWith,
		tool,
		dispatchWith,
		dispatch,
		toolA,
		dispatchA,
		addItem,
		cleanup: () => {
			rmSync(HOME, { recursive: true, force: true });
			rmSync(REPO, { recursive: true, force: true });
		},
	};
};

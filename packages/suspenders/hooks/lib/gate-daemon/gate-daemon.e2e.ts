// gate-daemon.e2e.ts — hub governor daemon parity (hub-of-one phase 5):
// the same tool-call payload evaluated per-call (`bun gate.ts <event>`) and
// through the warm store-server (SUSPENDERS_GATE_DAEMON=1) must print the
// same decision with the same exit code; a dead daemon falls back to the
// local evaluation (never fail-open); the host restores env/cwd/exit.
import { expect, test } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, scratchWorld, waitUp } from "@klh/test-kit";

const HOOKS = join(import.meta.dir, "..", "..");
const GATE = join(HOOKS, "gate.ts");
const STORE = join(HOOKS, "bin", "store-server.ts");

test.describe("@unit gate daemon", () => {
	// one store-server per describe: the metrics leg reads the calls the
	// parity legs made, so every test rides the same worker
	test.describe.configure({ mode: "serial" });
	const world = scratchWorld({ prefix: "gate-daemon-" });
	let port = 0;
	let server: ReturnType<typeof Bun.spawn> | null = null;
	const file = join(world.repo, "target.txt");
	const sid = "gate-daemon-sid-0001";

	test.beforeAll(async () => {
		writeFileSync(file, "alpha\nbeta\n");
		port = await freePort();
		const reg = join(world.home, ".cache", "claude-governor");
		mkdirSync(reg, { recursive: true });
		writeFileSync(join(reg, "store.url"), `http://127.0.0.1:${port}`);
		server = Bun.spawn(["bun", STORE, "--port", String(port)], {
			env: { ...world.env, SUSPENDERS_MDNS: "0", GOVERNOR_STORE_TOKEN: "" },
			stdout: "ignore",
			stderr: "ignore",
		});
		await waitUp(`http://127.0.0.1:${port}/health`);
	});
	test.afterAll(async () => {
		server?.kill();
		await server?.exited;
		world.clean();
	});

	// both arms bind the SAME store (scratchWorld pins "local", which by
	// design disables the daemon path): only SUSPENDERS_GATE_DAEMON differs
	const run = (
		event: string,
		payload: object,
		daemon: string,
		store = `http://127.0.0.1:${port}`,
		argv = ["bun", GATE, event],
	) => {
		const p = Bun.spawnSync(argv, {
			cwd: world.repo,
			env: {
				...world.env,
				GOVERNOR_STORE_URL: store,
				SUSPENDERS_GATE_DAEMON: daemon,
				SUSPENDERS_MDNS: "0",
			},
			stdin: new TextEncoder().encode(JSON.stringify(payload)),
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: p.exitCode, out: p.stdout.toString() };
	};
	const base = () => ({ session_id: sid, cwd: world.repo });
	const cases: [string, string, object][] = [
		[
			"anchor miss denies",
			"pre-files",
			{
				...base(),
				hook_event_name: "PreToolUse",
				tool_name: "Edit",
				tool_input: {
					file_path: file,
					old_string: "NOT-IN-THE-FILE",
					new_string: "x",
				},
			},
		],
		[
			"small read allows",
			"pre-read",
			{
				...base(),
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
			},
		],
		[
			"plain bash allows",
			"pre-bash",
			{
				...base(),
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "true" },
			},
		],
	];

	for (const [name, event, payload] of cases)
		test(`daemon parity: ${name}`, () => {
			const local = run(event, payload, "0");
			const viaDaemon = run(event, payload, "1");
			expect(viaDaemon).toEqual(local);
		});

	// lane identity walks the CALLER's process ancestry. The lane pid is a
	// wrapper that is gate.ts's parent but NOT an ancestor of store-server, so
	// only a daemon that walks the client pid can resolve it
	test("daemon parity: lane identity resolves through the client pid", () => {
		mkdirSync(join(world.repo, ".fleet"), { recursive: true });
		const lanes = join(world.repo, ".fleet", "lanes.json");
		const wrap = join(world.home, "lane-wrap.ts");
		writeFileSync(
			wrap,
			`import { writeFileSync } from "node:fs";
const [lanes, gate, event] = process.argv.slice(2);
writeFileSync(lanes, JSON.stringify([{ sid: "autow70d", item: "W70D", pid: process.pid, branch: "suspenders/W70D", worktree: process.cwd() }]));
const raw = await new Response(Bun.stdin).text();
const p = Bun.spawnSync(["bun", gate, event], { stdin: new TextEncoder().encode(raw), stdout: "pipe", env: process.env });
process.stdout.write(p.stdout);
process.exit(p.exitCode ?? 1);
`,
		);
		const wrapped = ["bun", wrap, lanes, GATE, "push"];
		const store = `http://127.0.0.1:${port}`;
		// the push gate tails the RESOLVED lane's inbox log: a line only the
		// lane autow70d can see proves which identity each arm resolved
		const log = join(
			world.home,
			".claude-insights",
			"coord-subscribe-autow70d.log",
		);
		mkdirSync(join(world.home, ".claude-insights"), { recursive: true });
		const payload = {
			...base(),
			hook_event_name: "PostToolUse",
			tool_name: "Read",
		};
		appendFileSync(log, "#1 NOTE via-daemon\n");
		expect(run("push", payload, "1", store, wrapped).out).toContain(
			"via-daemon",
		);
		appendFileSync(log, "#2 NOTE via-local\n");
		expect(run("push", payload, "0", store, wrapped).out).toContain(
			"via-local",
		);
	});

	test("the daemon path really served the hot events", async () => {
		const metrics = await (
			await fetch(`http://127.0.0.1:${port}/metrics`)
		).text();
		for (const ev of ["pre-files", "pre-read", "pre-bash"])
			expect(metrics).toContain(`/gate/${ev}`);
	});

	test("unreachable daemon falls back to the local decision", () => {
		const payload = cases[0][2];
		const dead = "http://127.0.0.1:9";
		const local = run("pre-files", payload, "0", dead);
		expect(run("pre-files", payload, "1", dead)).toEqual(local);
		expect(local.out).toContain("deny");
	});

	test("events the daemon does not serve answer 404 (stay per-call)", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/gate/post-files`, {
			method: "POST",
			body: "{}",
		});
		expect(res.status).toBe(404);
	});
});

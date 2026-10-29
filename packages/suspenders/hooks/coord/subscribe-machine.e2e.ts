// subscribe-machine.e2e.ts — one coord subscriber per machine (hub-of-one
// phase 5): a single `coord subscribe --machine` socket fans targeted events
// out to coord-subscribe-<target>.log and untargeted ones ONCE to
// coord-subscribe-_all.log; subagent lanes never open a socket; the push gate
// tails the shared log from the end on a lane's first read.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, runCli, scratchWorld, waitUp } from "@klh/test-kit";

const HOOKS = join(import.meta.dir, "..");
const COORD = join(HOOKS, "bin", "coord.ts");
const STORE = join(HOOKS, "bin", "store-server.ts");
const GATE = join(HOOKS, "gate.ts");

test.describe("@unit machine subscriber", () => {
	const world = scratchWorld({ prefix: "sub-machine-" });
	const tmp = join(world.home, "tmp");
	let port = 0;
	let env: Record<string, string | undefined> = {};
	const procs: ReturnType<typeof Bun.spawn>[] = [];
	const log = (id: string) =>
		join(world.home, ".claude-insights", `coord-subscribe-${id}.log`);
	const waitFor = async (file: string, needle: string) => {
		for (let i = 0; i < 100; i++) {
			if (existsSync(file) && readFileSync(file, "utf8").includes(needle))
				return;
			await Bun.sleep(100);
		}
		throw new Error(`${needle} never reached ${file}`);
	};

	test.beforeAll(async () => {
		mkdirSync(tmp, { recursive: true });
		port = await freePort();
		const store = `http://127.0.0.1:${port}`;
		env = {
			...world.env,
			GOVERNOR_STORE_URL: store,
			GOVERNOR_STORE_TOKEN: "",
			SUSPENDERS_MDNS: "0",
			TMPDIR: tmp,
		};
		procs.push(
			Bun.spawn(["bun", STORE, "--port", String(port)], {
				env,
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		await waitUp(`${store}/health`);
		procs.push(
			Bun.spawn(["bun", COORD, "subscribe", "--machine"], {
				env,
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		await Bun.sleep(1500); // socket open
	});
	test.afterAll(async () => {
		for (const p of procs) p.kill();
		await Promise.all(procs.map((p) => p.exited));
		world.clean();
	});

	test("targeted event lands in the target's log only", async () => {
		const r = runCli(
			COORD,
			["emit", "NOTE", "--to", "sid-a", "--note", "for-a-only", "--as", "t"],
			{ env },
		);
		expect(r.code).toBe(0);
		await waitFor(log("sid-a"), "for-a-only");
		expect(existsSync(log("sid-b"))).toBe(false);
	});

	test("untargeted event lands once in the shared log", async () => {
		const r = runCli(
			COORD,
			["emit", "MACHINE_PROBE", "--note", "for-everyone", "--as", "t"],
			{ env },
		);
		expect(r.code).toBe(0);
		await waitFor(log("_all"), "for-everyone");
		const text = readFileSync(log("_all"), "utf8");
		expect(text.split("for-everyone").length - 1).toBe(1);
		expect(readFileSync(log("sid-a"), "utf8")).not.toContain("for-everyone");
	});

	test("push gate starts the shared log at its end, then delivers", async () => {
		const push = () => {
			const p = Bun.spawnSync(["bun", GATE, "push"], {
				cwd: world.repo,
				env: { ...env, SUSPENDERS_SID: "sid-c" },
				stdin: new TextEncoder().encode(
					JSON.stringify({
						session_id: "sid-c",
						cwd: world.repo,
						hook_event_name: "PostToolUse",
						tool_name: "Read",
					}),
				),
				stdout: "pipe",
			});
			return p.stdout.toString();
		};
		expect(push()).not.toContain("for-everyone"); // no history replay
		runCli(
			COORD,
			["emit", "MACHINE_PROBE", "--note", "fresh-one", "--as", "t"],
			{
				env,
			},
		);
		await waitFor(log("_all"), "fresh-one");
		expect(push()).toContain("fresh-one");
	});

	test("subagent lanes and an already-live machine socket spawn nothing", async () => {
		const probe = join(tmp, "attach.ts");
		writeFileSync(
			probe,
			`const m = await import(${JSON.stringify(join(HOOKS, "lib", "lanes", "subscribe-attach.ts"))});
console.log(JSON.stringify([m.attachSubscribe("p#agent-x"), m.attachSubscribe("sid-z")]));`,
		);
		const r = runCli(probe, [], { env });
		expect(r.out.trim()).toBe("[false,false]");
	});
});

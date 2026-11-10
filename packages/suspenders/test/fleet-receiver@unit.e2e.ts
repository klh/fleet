// test/fleet-receiver@unit.e2e.ts — W2863 face (a): the pi fleet-receiver's
// pure plane logic — feed-line parsing, targeted-kind filter, injection
// composition (reply/ack recipes + lane id), byte-cursor tail of the
// per-session feed log, and machine-subscriber liveness probe (pid file +
// ps argv regex). Rides the kit (W1135.1.3).
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	composeInjection,
	consultIdOf,
	isTargeted,
	machineSubscriberLive,
	parseFeedLine,
	readNewFeedLines,
} from "../pi-extensions/fleet-receiver/index.ts";
import fleetReceiver from "../pi-extensions/fleet-receiver/index.ts";

const world = scratchWorld({ prefix: "fleet-rcv-" });
const CONSULT_LINE =
	"#117283 01a1bb57 consult  project=/x consult=C294 q=is+the+receiver+live?";

test.describe("@unit", () => {
	test("feed-line parse + targeted filter + consult id", () => {
		expect(parseFeedLine(CONSULT_LINE)).toEqual({
			id: 117283,
			from: "01a1bb57",
			kind: "consult",
		});
		expect(parseFeedLine("not a feed line")).toBeNull();
		expect(isTargeted("consult")).toBe(true);
		expect(isTargeted("message")).toBe(true);
		expect(isTargeted("consult.answer")).toBe(true);
		expect(isTargeted("need_decision")).toBe(true);
		expect(isTargeted("need-decision")).toBe(true);
		expect(isTargeted("work.added")).toBe(false);
		expect(consultIdOf(CONSULT_LINE)).toBe("C294");
		expect(consultIdOf("#1 aa work.added x=1")).toBeNull();
	});
	test("composeInjection: consult → reply+ack recipe; answer → feedback; message → ack", () => {
		const t = composeInjection(CONSULT_LINE, "pi-abc");
		expect(t).toContain("event #117283");
		expect(t).toContain('coord consult-reply C294 "<answer>" --as pi-abc');
		expect(t).toContain("coord ack 117283 --as pi-abc");
		expect(t).toContain("Your lane id: pi-abc");
		const a = composeInjection(
			"#117300 01a1bb57 consult.answer  consult=C294 from=01a1bb57",
			"pi-abc",
		);
		expect(a).toContain("--feedback resolved|failed");
		const m = composeInjection("#117301 aa message  note=hello", "pi-abc");
		expect(m).toContain("coord ack 117301 --as pi-abc");
		expect(m).not.toContain("consult-reply");
		expect(composeInjection("junk", "pi-abc")).toBe("");
	});
	test("readNewFeedLines: byte cursor returns only new complete lines", () => {
		const log = join(world.home, "feed.log");
		const body = `${CONSULT_LINE}\njunk line, not a feed line\n#1 aa work.added x=1\n`;
		writeFileSync(log, body);
		const r1 = readNewFeedLines(log, 0);
		expect(r1.lines).toHaveLength(2);
		expect(r1.lines[0]).toContain("consult=C294");
		const size1 = Buffer.byteLength(body, "utf8");
		expect(r1.cursor).toBe(size1);
		const r2 = readNewFeedLines(log, r1.cursor);
		expect(r2.lines).toHaveLength(0);
		expect(r2.cursor).toBe(size1);
		const more = "#117400 01a1bb57 message  note=late+arrival\n";
		writeFileSync(log, `${body}${more}`);
		const r3 = readNewFeedLines(log, size1);
		expect(r3.lines).toEqual(["#117400 01a1bb57 message  note=late+arrival"]);
		expect(r3.cursor).toBe(size1 + Buffer.byteLength(more, "utf8"));
		expect(readNewFeedLines(join(world.home, "absent.log"), 7)).toEqual({
			lines: [],
			cursor: 0,
		});
	});
	test("machineSubscriberLive: pid file + ps argv regex (missing/garbage/dead/live)", async () => {
		const h = join(world.home, "rcv-home");
		mkdirSync(join(h, ".claude-insights"), { recursive: true });
		expect(machineSubscriberLive(h)).toBe(false);
		writeFileSync(
			join(h, ".claude-insights/coord-subscribe-machine.pid"),
			"not-a-pid",
		);
		expect(machineSubscriberLive(h)).toBe(false);
		const script = join(h, "fake-coord.ts");
		writeFileSync(script, "await new Promise((r) => setTimeout(r, 30000));\n");
		const proc = Bun.spawn(["bun", script, "subscribe", "--machine"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		writeFileSync(
			join(h, ".claude-insights/coord-subscribe-machine.pid"),
			String(proc.pid),
		);
		expect(machineSubscriberLive(h)).toBe(true);
		proc.kill();
		await proc.exited;
		expect(machineSubscriberLive(h)).toBe(false);
	});

	// W2863.1 — the Pi 1.5 SDK hands session_start (event, ctx); the receiver
	// must attach on the 2-arg call, await bootstrap BEFORE the subscriber
	// decision, and run with globalThis.Bun deleted (managed pi launcher =
	// Node).
	test("session_start (event, ctx) attaches; bootstrap precedes subscribe spawn", async () => {
		const bin = join(world.home, "bin");
		mkdirSync(bin, { recursive: true });
		const log = join(bin, "invocations.jsonl");
		writeFileSync(
			join(bin, "coord"),
			'#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\n' +
				`appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
			{ mode: 0o755 },
		);
		const prevPath = process.env.PATH;
		const prevHome = process.env.HOME;
		process.env.PATH = `${bin}:${prevPath ?? ""}`;
		const home = join(world.home, "rcv-order-home");
		mkdirSync(join(home, ".claude-insights"), { recursive: true });
		process.env.HOME = home;
		const handlers: Record<string, (...a: unknown[]) => void> = {};
		const pi = {
			on: (k: string, h: (...a: unknown[]) => void) => {
				handlers[k] = h;
			},
			sendUserMessage: async () => {},
		};
		fleetReceiver(pi as never);
		expect(typeof handlers.session_start).toBe("function");
		handlers.session_start(
			{},
			{
				sessionManager: { getSessionId: () => "witness9" },
				cwd: world.home,
				isIdle: () => true,
				hasUI: false,
			},
		);
		const sidFile = join(home, ".claude-insights/fleet-receiver-witness9.sid");
		let sid = "";
		let invs: string[][] = [];
		for (let i = 0; i < 100 && (!sid || invs.length < 2); i++) {
			await new Promise((r) => setTimeout(r, 50));
			try {
				sid = readFileSync(sidFile, "utf8").trim();
			} catch {}
			try {
				invs = readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as string[]);
			} catch {}
		}
		process.env.PATH = prevPath;
		process.env.HOME = prevHome;
		expect(sid).toBe("pi-witness9");
		expect(invs[0]?.[0]).toBe("bootstrap");
		expect(invs[1]?.[0]).toBe("subscribe");
		expect(invs[1]).toContain("pi-witness9");
		handlers.session_shutdown();
	});

	test("live machine subscriber → attach spawns no per-session subscribe", async () => {
		const bin = join(world.home, "bin");
		const log = join(bin, "invocations.jsonl");
		const subs = () => {
			try {
				return readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as string[])
					.filter((a) => a[0] === "subscribe").length;
			} catch {
				return 0;
			}
		};
		const home = join(world.home, "rcv-live-home");
		mkdirSync(join(home, ".claude-insights"), { recursive: true });
		const script = join(home, "fake-coord.ts");
		writeFileSync(script, "await new Promise((r) => setTimeout(r, 30000));\n");
		const proc = Bun.spawn(["bun", script, "subscribe", "--machine"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		writeFileSync(
			join(home, ".claude-insights/coord-subscribe-machine.pid"),
			String(proc.pid),
		);
		const prevPath = process.env.PATH;
		const prevHome = process.env.HOME;
		process.env.PATH = `${bin}:${prevPath ?? ""}`;
		process.env.HOME = home;
		const before = subs();
		const handlers: Record<string, (...a: unknown[]) => void> = {};
		fleetReceiver({
			on: (k: string, h: (...a: unknown[]) => void) => {
				handlers[k] = h;
			},
			sendUserMessage: async () => {},
		} as never);
		handlers.session_start(
			{},
			{
				sessionManager: { getSessionId: () => "witness10" },
				cwd: world.home,
				isIdle: () => true,
				hasUI: false,
			},
		);
		const sidFile = join(home, ".claude-insights/fleet-receiver-witness10.sid");
		let sid = "";
		for (let i = 0; i < 100 && !sid; i++) {
			await new Promise((r) => setTimeout(r, 50));
			try {
				sid = readFileSync(sidFile, "utf8").trim();
			} catch {}
		}
		process.env.PATH = prevPath;
		process.env.HOME = prevHome;
		expect(sid).toBe("pi-witness10");
		expect(subs()).toBe(before);
		handlers.session_shutdown();
		proc.kill();
		await proc.exited;
	});

	test("receiver module loads + helpers run under real Node (Bun never loaded)", () => {
		const receiverPath = join(
			import.meta.dir,
			"../pi-extensions/fleet-receiver/index.ts",
		);
		const probe = join(world.home, "node-probe.ts");
		writeFileSync(
			probe,
			[
				`import { parseFeedLine, machineSubscriberLive } from ${JSON.stringify(receiverPath)};`,
				`import { mkdirSync, writeFileSync } from "node:fs";`,
				`import { join } from "node:path";`,
				`const dir = ${JSON.stringify(join(world.home, "rcv-nobun-home"))};`,
				"mkdirSync(join(dir, '.claude-insights'), { recursive: true });",
				"writeFileSync(join(dir, '.claude-insights/coord-subscribe-machine.pid'), '999999999');",
				"if (globalThis.Bun !== undefined) throw new Error('Bun global present execPath=' + process.execPath + ' PATH=' + (process.env.PATH ?? '').split(':').filter((d) => /node|nvm/.test(d)).join(':'));",
				`if (parseFeedLine(${JSON.stringify(CONSULT_LINE)}).id !== 117283) throw new Error('parseFeedLine broke');`,
				`if (machineSubscriberLive(dir) !== false) throw new Error('liveness probe broke');`,
				"console.log('NODE-WITNESS-OK');",
			].join("\n"),
		);
		// bun --bun prepends a tmp dir holding node→bun to PATH — skip it so
		// the witness rides the REAL node (Bun-undefined environment)
		const realNode = (process.env.PATH ?? "")
			.split(":")
			.filter((d) => d && !/bun-node/.test(d))
			.map((d) => join(d, "node"))
			.find((p) => {
				try {
					return spawnSync(p, ["--version"], { encoding: "utf8" }).stdout.startsWith(
						"v",
					);
				} catch {
					return false;
				}
			});
		if (!realNode) throw new Error("no real node on PATH");
		const r = spawnSync(realNode, [probe], { encoding: "utf8" });
		expect(r.status, `node probe: ${r.stderr || r.stdout}`).toBe(0);
		expect(r.stdout).toContain("NODE-WITNESS-OK");
	});

	test.afterAll(() => {
		world.clean();
	});
});

// test/fleet-receiver@unit.e2e.ts — W2863 face (a): the pi fleet-receiver's
// pure plane logic — feed-line parsing, targeted-kind filter, injection
// composition (reply/ack recipes + lane id), byte-cursor tail of the
// per-session feed log, and machine-subscriber liveness probe (pid file +
// ps argv regex). Rides the kit (W1135.1.3).
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	composeInjection,
	consultIdOf,
	isTargeted,
	machineSubscriberLive,
	parseFeedLine,
	readNewFeedLines,
} from "../pi-extensions/fleet-receiver/index.ts";

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

	test.afterAll(() => {
		world.clean();
	});
});

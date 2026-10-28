// test/log.e2e.ts — W2173.7 the ONE leveled-logger seam: level filtering
// (only at/above the threshold emits), env resolution (BUCKLE_LOG_LEVEL),
// scope prefix, and the stream split (warn/error ride console.error).
import { expect, test } from "@playwright/test";
import { createLogger, resolveLogLevel } from "../src/log.ts";

type Row = [string, string];
const rows: Row[] = [];
const sink = (level: string, line: string): void => {
	rows.push([level, line]);
};

test.describe("log seam @unit", () => {
	test("levels filter below threshold; format is `<prefix> <LEVEL> <msg>`", () => {
		rows.length = 0;
		const log = createLogger("t", { level: "info", sink: sink as never });
		log.debug("hidden");
		log.info("seen");
		log.warn("seen");
		log.error("seen");
		expect(rows).toEqual([
			["info", "buckle:t info seen"],
			["warn", "buckle:t warn seen"],
			["error", "buckle:t error seen"],
		]);
	});

	test("resolveLogLevel reads BUCKLE_LOG_LEVEL; unknown keeps default", () => {
		expect(resolveLogLevel({})).toBe("info");
		expect(resolveLogLevel({ BUCKLE_LOG_LEVEL: "debug" })).toBe("debug");
		expect(resolveLogLevel({ BUCKLE_LOG_LEVEL: "error" })).toBe("error");
		expect(resolveLogLevel({ BUCKLE_LOG_LEVEL: "loud" })).toBe("info");
		expect(resolveLogLevel({}, "warn")).toBe("warn");
	});

	test("level: warn filters info but not error", () => {
		rows.length = 0;
		const log = createLogger("t2", { level: "warn", sink: sink as never });
		log.info("x");
		log.error("y");
		expect(rows.map((r) => r[1])).toEqual(["buckle:t2 error y"]);
	});
});

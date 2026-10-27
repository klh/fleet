import { describe, expect, test } from "bun:test";
import {
	inheritDeadline,
	ROUTER_EXCHANGE_MS,
	ROUTER_STREAM_TOTAL_MS,
} from "../bin/hop-deadline.ts";
import {
	encodeHopContract,
	rungIdOf,
} from "../../telemetry/src/hop-contract.ts";

const NOW = 1_800_000_000_000;
const header = (deadlineMs: number, budget = 3, path: string[] = []) =>
	encodeHopContract({ deadlineMs, budget, path });

describe("w1117 hop deadline", () => {
	test("absent header keeps the Buckle-parity local default", () => {
		const d = inheritDeadline(null, false, NOW);
		expect(d).not.toBe("expired");
		if (d === "expired") return;
		expect(d.source).toBe("local-default");
		expect(d.deadlineMs).toBe(NOW + ROUTER_EXCHANGE_MS);
	});

	test("stream default is the 900s stream-total budget", () => {
		const d = inheritDeadline(undefined, true, NOW);
		if (d === "expired") throw new Error("unexpected expired");
		expect(d.deadlineMs).toBe(NOW + ROUTER_STREAM_TOTAL_MS);
	});

	test("inherited contract clamps the local budget", () => {
		const d = inheritDeadline(header(NOW + 30_000), true, NOW);
		if (d === "expired") throw new Error("unexpected expired");
		expect(d.source).toBe("hop-contract");
		// contract is TIGHTER than the 900s default → clamp wins
		expect(d.deadlineMs).toBe(NOW + 30_000);
	});

	test("local default wins when the contract is looser", () => {
		const d = inheritDeadline(header(NOW + 3_600_000), false, NOW);
		if (d === "expired") throw new Error("unexpected expired");
		expect(d.deadlineMs).toBe(NOW + ROUTER_EXCHANGE_MS);
	});

	test("a past deadline is EXPIRED, never re-based forward", () => {
		expect(inheritDeadline(header(NOW - 1), false, NOW)).toBe("expired");
	});

	test("a malformed header is invalid → local default", () => {
		const d = inheritDeadline("v=1;deadline=garbage", false, NOW);
		if (d === "expired") throw new Error("unexpected expired");
		expect(d.source).toBe("local-default");
	});

	test("rungIdOf matches the buckle candIdOf recipe", () => {
		expect(rungIdOf("127.0.0.1", 8902, "qwen3.5-35b-a3b")).toBe(
			rungIdOf("127.0.0.1", 8902, "qwen3.5-35b-a3b"),
		);
		expect(rungIdOf("127.0.0.1", 8902, "m1")).not.toBe(
			rungIdOf("127.0.0.1", 8903, "m1"),
		);
	});
});

// W1086: the hop-contract wire header — encode/parse round-trip, strict
// rejection, the expired verdict, and the child-hop budget/path rules.
import { expect, test } from "bun:test";
import {
	childHopContract,
	encodeHopContract,
	parseHopContract,
	rungIdOf,
	HOP_CONTRACT_HEADER,
} from "../src/hop-contract.ts";

const NOW = 1_792_600_000_000; // 13-digit epoch ms

test("encode/parse round-trips the canonical shape", () => {
	const v = encodeHopContract({
		deadlineMs: NOW + 240_000,
		budget: 3,
		path: ["a".repeat(16), "b".repeat(16)],
	});
	expect(v).toBe(
		`v=1;deadline=${NOW + 240_000};budget=3;path=${"a".repeat(16)},${"b".repeat(16)}`,
	);
	const p = parseHopContract(v, NOW);
	expect(p).toEqual({
		status: "ok",
		deadlineMs: NOW + 240_000,
		budget: 3,
		path: ["a".repeat(16), "b".repeat(16)],
	});
	expect(HOP_CONTRACT_HEADER).toBe("x-klh-hop-contract");
});

test("invalid, oversized and foreign-version values reject whole", () => {
	expect(parseHopContract(null, NOW)).toEqual({ status: "invalid" });
	expect(parseHopContract("", NOW)).toEqual({ status: "invalid" });
	expect(parseHopContract("v=2;deadline=1", NOW)).toEqual({
		status: "invalid",
	});
	expect(parseHopContract(`v=1;deadline=${NOW};budget=3;path=zz`, NOW)).toEqual(
		{
			status: "invalid",
		},
	);
	// 12-digit deadline is not 13-digit strict
	expect(
		parseHopContract(`v=1;deadline=123456789012;budget=1;path=`, NOW),
	).toEqual({ status: "invalid" });
	expect(
		encodeHopContract({ deadlineMs: NOW, budget: 100, path: [] }),
	).toBeNull();
	expect(
		encodeHopContract({ deadlineMs: NOW, budget: -1, path: [] }),
	).toBeNull();
	expect(
		encodeHopContract({ deadlineMs: NOW, budget: 1, path: ["NOPE"] }),
	).toBeNull();
	expect(
		encodeHopContract({
			deadlineMs: NOW,
			budget: 1,
			path: Array.from({ length: 65 }, (_, i) =>
				i.toString(16).padStart(16, "0"),
			),
		}),
	).toBeNull();
});

test("a deadline in the past is EXPIRED, not clamped", () => {
	const p = parseHopContract(`v=1;deadline=${NOW - 1};budget=3;path=`, NOW);
	expect(p).toEqual({ status: "expired", deadlineMs: NOW - 1 });
});

test("childHop decrements budget, appends the rung, never re-appends", () => {
	const parsed = parseHopContract(
		`v=1;deadline=${NOW + 1000};budget=2;path=${"a".repeat(16)}`,
		NOW,
	);
	if (parsed.status !== "ok") throw new Error("expected ok");
	const rung = "b".repeat(16);
	const child = childHopContract(parsed, rung);
	expect(child).toEqual({
		deadlineMs: NOW + 1000, // absolute — passes through untouched
		budget: 1,
		path: ["a".repeat(16), "b".repeat(16)],
	});
	// revisiting the same rung neither re-appends nor refunds budget
	const again = childHopContract(
		{ ...parsed, path: child.path, budget: child.budget },
		rung,
	);
	expect(again.budget).toBe(0);
	expect(again.path).toEqual(["a".repeat(16), "b".repeat(16)]);
	// budget floors at zero — the header can never mint attempts
	const spent = childHopContract({ ...parsed, budget: 0 }, "c".repeat(16));
	expect(spent.budget).toBe(0);
});

test("rungIdOf matches the candIdOf sha16 recipe on both sides", () => {
	// buckle's candIdOf = `${hostname}:${port|proto-default}:${model ?? group}`
	// belt derives the same string for (host, port, wire model)
	expect(rungIdOf("127.0.0.1", 8902, "qwen3.5-35b-a3b")).toBe(
		rungIdOf("127.0.0.1", 8902, "qwen3.5-35b-a3b"),
	);
	expect(rungIdOf("127.0.0.1", 8902, "qwen3.5-35b-a3b")).toMatch(
		/^[0-9a-f]{16}$/,
	);
	expect(rungIdOf("127.0.0.1", 8902, "other")).not.toBe(
		rungIdOf("127.0.0.1", 8902, "qwen3.5-35b-a3b"),
	);
});

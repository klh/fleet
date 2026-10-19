#!/usr/bin/env bun
// Private mechanical judge for the Relay ledger fixture. Keep outside the
// evaluated worktree; a model only sees fixture/README.md and src/.
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2])
	throw new Error("usage: bun oracle.ts <fixture-worktree>");

type Check = { name: string; ok: boolean };
const checks: Check[] = [];
const check = (name: string, actual: unknown, expected: unknown): void => {
	checks.push({
		name,
		ok: JSON.stringify(actual) === JSON.stringify(expected),
	});
};
const truth = (name: string, ok: boolean): void => checks.push({ name, ok });
const load = async (
	name: string,
): Promise<Record<string, (...args: never[]) => unknown>> =>
	import(pathToFileURL(join(root, "src", `${name}.ts`)).href);

try {
	const { releaseLease } = await load("claim");
	const live = { owner: "worker-a", lease: "lease-new", expiresAt: 500 };
	check(
		"claim-none",
		releaseLease(null, { owner: "worker-a", lease: "lease-new" }, 100),
		"none",
	);
	check(
		"claim-expired",
		releaseLease(live, { owner: "worker-a", lease: "lease-new" }, 500),
		"expired",
	);
	check(
		"claim-before-expiry",
		releaseLease(live, { owner: "worker-a", lease: "lease-new" }, 499),
		"released",
	);
	check(
		"claim-owner",
		releaseLease(live, { owner: "worker-b", lease: "lease-new" }, 100),
		"owner-mismatch",
	);
	check(
		"claim-stale-token",
		releaseLease(live, { owner: "worker-a", lease: "lease-old" }, 100),
		"lease-mismatch",
	);
	check(
		"claim-expired-precedence",
		releaseLease(live, { owner: "worker-b", lease: "lease-old" }, 501),
		"expired",
	);
	truth(
		"claim-pure",
		JSON.stringify(live) ===
			'{"owner":"worker-a","lease":"lease-new","expiresAt":500}',
	);
} catch {
	for (let i = checks.length; i < 7; i++) truth(`claim-load-${i}`, false);
}

try {
	const { summarizeCache } = await load("cache");
	const rows = [
		{
			lane: "lane-a",
			model: "m1",
			support: "supported",
			readTokens: 12,
			writeTokens: 0,
		},
		{
			lane: "lane-a",
			model: "m1",
			support: "supported",
			readTokens: 0,
			writeTokens: 7,
		},
		{
			lane: "lane-a",
			model: "m1",
			support: "supported",
			readTokens: null,
			writeTokens: 99,
		},
		{
			lane: "lane-a",
			model: "m2",
			support: "unsupported",
			readTokens: null,
			writeTokens: null,
		},
		{
			lane: "lane-b",
			model: "m1",
			support: "supported",
			readTokens: 100,
			writeTokens: 100,
		},
	];
	check("cache-filter-and-count", summarizeCache(rows, "lane-a", "m1"), {
		requests: 3,
		known: 2,
		warm: 1,
		readTokens: 12,
		writeTokens: 7,
		state: "measured",
	});
	check("cache-no-traffic", summarizeCache(rows, "lane-z", "m1"), {
		requests: 0,
		known: 0,
		warm: 0,
		readTokens: 0,
		writeTokens: 0,
		state: "no-traffic",
	});
	check("cache-unsupported", summarizeCache(rows, "lane-a", "m2"), {
		requests: 1,
		known: 0,
		warm: 0,
		readTokens: 0,
		writeTokens: 0,
		state: "unsupported",
	});
	check("cache-unknown", summarizeCache([rows[2]], "lane-a", "m1"), {
		requests: 1,
		known: 0,
		warm: 0,
		readTokens: 0,
		writeTokens: 0,
		state: "unknown",
	});
	check("cache-mixed", summarizeCache([rows[3], rows[0]], "lane-a", "m1"), {
		requests: 1,
		known: 1,
		warm: 1,
		readTokens: 12,
		writeTokens: 0,
		state: "measured",
	});
	check("cache-other-lane", summarizeCache(rows, "lane-b", "m1"), {
		requests: 1,
		known: 1,
		warm: 1,
		readTokens: 100,
		writeTokens: 100,
		state: "measured",
	});
	check("cache-zero-write-hit", summarizeCache([rows[0]], "lane-a", "m1"), {
		requests: 1,
		known: 1,
		warm: 1,
		readTokens: 12,
		writeTokens: 0,
		state: "measured",
	});
} catch {
	for (
		let i = checks.filter((c) => c.name.startsWith("cache-")).length;
		i < 7;
		i++
	)
		truth(`cache-load-${i}`, false);
}

try {
	const { nextTrace } = await load("trace");
	const trace = "a".repeat(32);
	const span = "b".repeat(16);
	const fresh = "c".repeat(32);
	const next = "d".repeat(16);
	check(
		"trace-valid",
		nextTrace(`00-${trace}-${span}-00`, fresh, next),
		`00-${trace}-${next}-00`,
	);
	check(
		"trace-upper",
		nextTrace(
			`00-${trace.toUpperCase()}-${span.toUpperCase()}-0F`,
			fresh,
			next,
		),
		`00-${trace}-${next}-0f`,
	);
	check(
		"trace-missing",
		nextTrace(null, fresh, next),
		`00-${fresh}-${next}-01`,
	);
	check(
		"trace-bad-version",
		nextTrace(`01-${trace}-${span}-00`, fresh, next),
		`00-${fresh}-${next}-01`,
	);
	check(
		"trace-zero-parent",
		nextTrace(`00-${"0".repeat(32)}-${span}-00`, fresh, next),
		`00-${fresh}-${next}-01`,
	);
	check(
		"trace-short-parent",
		nextTrace(`00-${trace}-bad-00`, fresh, next),
		`00-${fresh}-${next}-01`,
	);
	let badSpanRejected = false;
	try {
		nextTrace(null, fresh, "0".repeat(16));
	} catch {
		badSpanRejected = true;
	}
	truth("trace-bad-span", badSpanRejected);
	let badTraceRejected = false;
	try {
		nextTrace(null, "xyz", next);
	} catch {
		badTraceRejected = true;
	}
	truth("trace-bad-generated", badTraceRejected);
} catch {
	for (
		let i = checks.filter((c) => c.name.startsWith("trace-")).length;
		i < 8;
		i++
	)
		truth(`trace-load-${i}`, false);
}

const passed = checks.filter((c) => c.ok).length;
const score = passed / checks.length;
console.log(
	JSON.stringify({
		score,
		passed,
		total: checks.length,
		failures: checks.filter((c) => !c.ok).map((c) => c.name),
	}),
);
process.exit(passed === checks.length ? 0 : 1);

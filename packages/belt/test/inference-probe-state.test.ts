import { describe, expect, test } from "bun:test";
import { buildTopology } from "../bin/dashboard-topology-model.js";
import {
	classifyInferenceProbe,
	inferenceProbePath,
	projectInferenceState,
	readInferenceProbeFeed,
	type InferenceProbeRecord,
} from "../bin/inference-probe-state.ts";

const record = (over: Partial<InferenceProbeRecord>): InferenceProbeRecord => ({
	state: "ok",
	checkedAt: 1000,
	expiresAt: 2000,
	latencyMs: 12,
	model: "wire-model",
	detail: "probe passed",
	httpStatus: 200,
	...over,
});

describe("classifyInferenceProbe", () => {
	test("2xx with body is verified usable inference", () => {
		expect(classifyInferenceProbe(200, '{"content":"x"}')).toBe("ok");
	});
	test("2xx without body is not green", () => {
		expect(classifyInferenceProbe(200, "  ")).toBe("failed");
	});
	test("401 and 403 are auth failure, distinct from quota", () => {
		expect(classifyInferenceProbe(401, "")).toBe("auth");
		expect(classifyInferenceProbe(403, "")).toBe("auth");
	});
	test("429 with money-side signal is billing, plain 429 is quota", () => {
		expect(classifyInferenceProbe(429, "insufficient credit")).toBe("billing");
		expect(classifyInferenceProbe(429, "rate limit exceeded")).toBe("quota");
	});
	test("other statuses fail without provider hardcoding", () => {
		expect(classifyInferenceProbe(500, "")).toBe("failed");
		expect(classifyInferenceProbe(503, "")).toBe("failed");
	});
});

describe("projectInferenceState", () => {
	test("absent record is untested, never green", () => {
		expect(projectInferenceState(undefined, 9999)).toBe("untested");
	});
	test("fresh verdict stands; expired reads stale", () => {
		expect(projectInferenceState(record({}), 1999)).toBe("ok");
		expect(projectInferenceState(record({}), 2000)).toBe("stale");
		expect(
			projectInferenceState(record({ state: "quota", httpStatus: 429 }), 1999),
		).toBe("quota");
	});
});

describe("readInferenceProbeFeed", () => {
	test("unreadable or missing file is untested, never green", () => {
		expect(readInferenceProbeFeed("/nonexistent/feed.json", 9999)).toEqual({});
	});
	test("feed older than 24h is discarded wholesale", () => {
		expect(
			readInferenceProbeFeed("/nonexistent/feed.json", 1000 + 25 * 60 * 60_000),
		).toEqual({});
	});
	test("inferenceProbePath lands under the HOME cache", () => {
		expect(inferenceProbePath("/home/x")).toBe(
			"/home/x/.cache/klh/belt/inference-probe.json",
		);
	});
});

describe("buildTopology inference join", () => {
	const now = Date.parse("2026-10-23T10:00:00Z");
	const payload = {
		ok: true,
		ts: now - 1000,
		rows: [
			{
				machine: "zai",
				host: "api.z.ai",
				port: 443,
				protocol: "openai",
				ok: true,
				last_seen: now - 2000,
			},
		],
		routes: [],
	};
	const topology = buildTopology(
		{ observation: { expiresAt: now + 10_000 }, specialists: [] },
		payload,
		{ observation: { expiresAt: now + 10_000 }, targets: [] },
		now,
		null,
		null,
		{
			inference: {
				zai: {
					state: "ok",
					checkedAt: now - 500,
					latencyMs: 9,
					model: "wire-model",
					detail: "verified",
					httpStatus: 200,
				},
			},
		},
		{ models: [] },
	);
	test("probed provider carries the projected verdict", () => {
		const zai = topology.providers.find((item) => item.key === "zai");
		expect(zai?.inference?.state).toBe("ok");
		expect(zai?.inference?.latencyMs).toBe(9);
	});
	test("second provider without feed data reads untested", () => {
		expect(
			topology.providers
				.filter((item) => item.key !== "zai")
				.every((item) => item.inference?.state === "untested"),
		).toBe(true);
	});
});

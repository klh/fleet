// test/lane-wire.test.ts — W1729: the production endpoint join. Stack rows
// (identity: url + exact provider model id) × the canonical capability
// snapshot (facts) via W1711's groupWireEndpoints; unknown never refuses or
// re-selects.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CapabilityRegistry,
	type ModelCapabilityRecord,
	writeCapabilitySnapshot,
} from "@klh/belt/bin/model-capabilities.ts";
import { stackWireEndpoints, wirePick } from "../scripts/lib/lane-wire.ts";

describe("W1729 stack wire endpoints", () => {
	const OBSERVED = new Date().toISOString();
	const record = (
		provider: string,
		modelId: string,
		endpoints: string[],
	): ModelCapabilityRecord => ({
		provider,
		modelId,
		locality: { value: "remote", source: "catalog", observedAt: OBSERVED },
		inputModalities: {
			value: ["text"],
			source: "catalog",
			observedAt: OBSERVED,
		},
		outputModalities: {
			value: ["text"],
			source: "catalog",
			observedAt: OBSERVED,
		},
		contextTokens: { value: 200_000, source: "catalog", observedAt: OBSERVED },
		maxOutputTokens: { value: 64_000, source: "catalog", observedAt: OBSERVED },
		tools: { value: true, source: "catalog", observedAt: OBSERVED },
		structuredOutput: { value: false, source: "catalog", observedAt: OBSERVED },
		cost: { value: null, source: null, observedAt: null },
		endpoints: { value: endpoints, source: "catalog", observedAt: OBSERVED },
	});
	const stack = {
		hubs: {
			desk: {
				upstreams: {
					groups: {
						"gpt-6.1-sol": [
							{
								url: "https://api.githubcopilot.com",
								model: "gpt-6.1-sol",
							},
						],
						"claude-old": [
							{
								url: "https://api.githubcopilot.com",
								model: "claude-old-4",
							},
							{ url: "http://127.0.0.1:4000", model: "local-reason" },
						],
					},
				},
			},
		},
	} as unknown as Parameters<typeof stackWireEndpoints>[0];
	let dir: string;
	let snapshotPath: string;
	const endpoints = () => stackWireEndpoints(stack, snapshotPath);
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "w1729-wire-"));
		snapshotPath = join(dir, "model-capabilities.json");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("an absent group reads unknown", async () => {
		expect(await endpoints()("no-such-group")).toBeNull();
	});

	test("join over the snapshot: responses-only model serves /v1/responses", async () => {
		await writeCapabilitySnapshot(
			snapshotPath,
			new CapabilityRegistry([
				record("copilot", "gpt-6.1-sol", ["/v1/responses"]),
			]),
		);
		expect(await endpoints()("gpt-6.1-sol")).toEqual(["/v1/responses"]);
	});

	test("an unknown row in the group reads unknown (keeps the pick)", async () => {
		await writeCapabilitySnapshot(
			snapshotPath,
			new CapabilityRegistry([
				record("copilot", "gpt-6.1-sol", ["/v1/responses"]),
				record("copilot", "claude-old-4", ["/v1/messages"]),
			]),
		);
		// claude-old: the local 127.0.0.1:4000 row has no catalog record — the
		// union reads unknown even though the copilot row is known.
		expect(await endpoints()("claude-old")).toBeNull();
	});

	test("an unreadable snapshot reads unknown", async () => {
		const broken = () => stackWireEndpoints(stack, join(dir, "missing.json"));
		expect(await broken()("gpt-6.1-sol")).toBeNull();
	});

	test("a claude-defaulted responses-only pin switches to codex end-to-end", async () => {
		await writeCapabilitySnapshot(
			snapshotPath,
			new CapabilityRegistry([
				record("copilot", "gpt-6.1-sol", ["/v1/responses"]),
			]),
		);
		const pick = { bin: "claude", model: "gpt-6.1-sol" };
		expect(await wirePick(pick, endpoints(), true)).toEqual({
			ok: true,
			bin: "codex",
			switched: true,
		});
	});

	test("a plaid explicit pairing refuses pre-claim", async () => {
		const wire = await wirePick(
			{ bin: "claude", model: "gpt-6.1-sol" },
			endpoints(),
			false,
		);
		expect(wire.ok).toBe(false);
	});
});

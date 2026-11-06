import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { pushProfileEnv } from "../deploy/hub-profiles.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

// W2788: buckle OTLP trace export flips on per hub — a profile declaring
// `otel:` renders the collector URL + sample rate; undeclared renders
// nothing (buckle export-off), and compose maps both into buckle's env.

function render(hub: Record<string, unknown>): string[] {
	const lines: string[] = [];
	pushProfileEnv(hub as HubProfile, (k, v) => {
		if (v !== undefined) lines.push(`${k}=${String(v)}`);
	});
	return lines;
}

test("@unit declared otel renders endpoint + sample rate", () => {
	expect(
		render({ otel: { endpoint: "http://collector.invalid:4318", sample_rate: 0.5 } }),
	).toEqual([
		"HUB_BUCKLE_OTLP_ENDPOINT=http://collector.invalid:4318",
		"HUB_BUCKLE_OTLP_SAMPLE=0.5",
	]);
});

test("@unit undeclared otel renders nothing", () => {
	expect(render({})).toEqual([]);
});

test("@unit compose maps the otel knobs into the buckle env", () => {
	const t = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	expect(t).toContain(
		"BUCKLE_OTLP_ENDPOINT: ${HUB_BUCKLE_OTLP_ENDPOINT:-}",
	);
	expect(t).toContain("BUCKLE_OTLP_SAMPLE: ${HUB_BUCKLE_OTLP_SAMPLE:-}");
});

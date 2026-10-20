// test/metrics-coverage-ui.test.ts — W986.2: the trends chart must explain
// its latency coverage. Legacy zero-duration failure rows count in
// requests/errors but carry no latency sample, so the UI shows coverage
// (measured/requests) in the tooltip, an empty state when a window has no
// measured points, and never renders a 0 ms average for a failure-only
// bucket (the backend answers avg_ms null — metrics-history.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
	join(import.meta.dir, "..", "bin", "dashboard-observability.js"),
	"utf8",
);

describe("belt trends latency coverage", () => {
	test("note explains measured-only averaging", () => {
		expect(src).toContain("Average latency spans measured samples only");
		expect(src).toContain("but never in the average");
	});

	test("latency series is labelled measured and rides avg_ms null", () => {
		expect(src).toContain('label: "avg ms (measured)"');
		// bucket[3] null → "no measured samples", never a 0 ms readout
		expect(src).toContain('"no measured samples"');
	});

	test("tooltip carries measured/requests coverage", () => {
		// split-string assembly — the source literal is a live template
		const coverage = [
			"$",
			"{bucket[4] ?? 0}",
			"/$",
			"{bucket[1]} measured",
		].join("");
		expect(src).toContain(coverage);
	});

	test("empty state when the window has no measured points", () => {
		// wording stays descriptive of the gap, not of why routes lack samples
		expect(src).toContain("No measured response time in this window");
		expect(src).toContain("no timing sample");
		// the empty state is gated on the measured sum, not on request volume
		expect(src).toMatch(
			/measured > 0\s*\?\s*html`<div class="bt-trend-wrap"><div class="bt-latency">/,
		);
	});

	test("sparse table explains the — cells", () => {
		expect(src).toContain("Avg response “—” means no measured duration");
	});
});

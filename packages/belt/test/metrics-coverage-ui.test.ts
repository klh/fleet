// test/metrics-coverage-ui.test.ts — W1135.2: the trends latency-coverage
// behaviors are asserted on the REAL component render, not source text.
// belt-trends is captured through the customElements shim and its render()/
// body()/sparseBody() templates are walked to text with fixture buckets.
// (W986.2 law: legacy zero-duration failure rows count in requests/errors
// but carry no latency sample — the UI shows measured-only averaging, an
// empty state when a window has no measured points, and never a 0 ms
// average for a failure-only bucket (avg_ms null — metrics-history.test.ts).
// The draw()-time uPlot tooltip strings need a DOM/canvas harness — the
// W1135 e2e child owns those.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin");
const defined = new Map<string, unknown>();

/** Sandbox bin dir: the chunk's bare-js imports (dashboard-state.js /
 *  observation.js) only exist in the flattened runtime home — the test
 *  satisfies them with stubs and imports the REAL chunk. */
let sandbox = "";

describe("belt trends latency coverage", () => {
	beforeAll(async () => {
		sandbox = mkdtempSync(join(tmpdir(), "belt-trends-ui-"));
		mkdirSync(join(sandbox, "vendor"));
		cpSync(
			join(BIN, "dashboard-observability.js"),
			join(sandbox, "dashboard-observability.js"),
		);
		cpSync(join(BIN, "vendor", "lit.js"), join(sandbox, "vendor", "lit.js"));
		// BeltSupervisor's helpers, stubbed — this file drives belt-trends only
		writeFileSync(
			join(sandbox, "dashboard-state.js"),
			`export const supervisorFresh = () => true;
export const restartEvidence = () => null;
export const targetStateLabel = () => "";`,
		);
		writeFileSync(
			join(sandbox, "observation.js"),
			`export const observationFresh = () => true;`,
		);
		const g = globalThis as unknown as {
			customElements?: {
				define(name: string, ctor: unknown): void;
				get(name: string): unknown;
			};
			HTMLElement?: unknown;
			document?: unknown;
		};
		// lit's vendored bundle extends HTMLElement at load, captures
		// `document` into a module local and builds a template tree-walker —
		// seed minimal stubs before the import (no DOM in bun:test; the
		// tests walk render() to text, never lit-render it)
		g.HTMLElement ??= class {};
		g.document ??= {
			createTreeWalker: () => ({ nextNode: () => null }),
		};
		g.customElements ??= {
			define: (name, ctor) => {
				defined.set(name, ctor);
			},
			get: (name) => defined.get(name),
		};
	});

	// the REAL chunk import — dashboard-state.js/observation.js only exist in
	// the runtime home, satisfied above by stubs; belt-trends is captured
	// through the customElements shim, and lifecycle rendering (which needs
	// a DOM) stays off — the tests drive render() directly
	beforeAll(async () => {
		await import(join(sandbox, "dashboard-observability.js"));
		const ctor = defined.get("belt-trends") as { prototype: object };
		(ctor.prototype as { performUpdate: () => void }).performUpdate = () => {};
	});

	afterAll(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	/** lit-html TemplateResult walked to text — no DOM needed. */
	function renderToText(value: unknown): string {
		if (value == null || typeof value === "boolean") return "";
		if (Array.isArray(value)) return value.map(renderToText).join("");
		const tpl = value as {
			strings?: ArrayLike<string>;
			values?: unknown[];
		};
		if (tpl.strings && tpl.values) {
			let out = "";
			const parts = tpl.strings;
			for (let i = 0; i < parts.length; i++) {
				out += parts[i];
				if (i < tpl.values.length) out += renderToText(tpl.values[i]);
			}
			return out;
		}
		return String(value);
	}

	/** bucket = [ts, requests, errors, avgMs|null, measuredCount?] on the
	 *  5-minute grid (the metrics-history payload shape). */
	function bucket(
		ts: number,
		requests: number,
		errors = 0,
		avgMs: number | null = null,
		measured = 0,
	): [number, number, number, number | null, number] {
		return [ts, requests, errors, avgMs, measured];
	}

	function hist(
		buckets: Array<[number, number, number, number | null, number]>,
		windowMs = 6 * 3600_000,
	): Hist {
		return {
			buckets,
			endpoints: [
				{ key: "mac:8902:m", models: ["extract"], counts: [3] },
			],
			windowMs,
		};
	}

	/** Instantiate the REAL belt-trends with a fixture and walk its render()
	 *  to text (body()/sparseBody() included via the template nesting). */
	function renderTrends(
		buckets: Array<[number, number, number, number | null, number]>,
	): string {
		const ctor = defined.get("belt-trends") as new () => {
			open: boolean;
			hist: Hist;
			render(): unknown;
		};
		const inst = new ctor();
		inst.open = true;
		inst.hist = hist(buckets);
		// body() degrades to the no-chart-engine note without uPlot; the
		// empty state lives behind that gate, so the chart engine is present
		const g = globalThis as unknown as { uPlot?: unknown };
		g.uPlot = g.uPlot ?? class {};
		try {
			return renderToText(inst.render());
		} finally {
			delete g.uPlot;
		}
	}

	interface Hist {
		buckets: Array<[number, number, number, number | null, number]>;
		endpoints: Array<{ key: string; models?: string[]; counts: number[] }>;
		windowMs: number;
	}

	const NOTE = "Average latency spans measured samples only";

	test("note explains measured-only averaging on a failure-only window", () => {
		// legacy zero-duration failure rows: requests/errors carry no sample
		const text = renderTrends([
			bucket(1800, 3, 3),
			bucket(3600, 4, 4),
			bucket(5400, 5, 5),
		]);
		expect(text).toContain(NOTE);
		expect(text).toContain(
			"count in requests and errors but never in the average",
		);
	});

	test("empty state gates on measured > 0, never a 0 ms average", () => {
		// 12 total requests across the window, every one a failure without a
		// duration — the latency chart is replaced by the empty state
		const empty = renderTrends([
			bucket(1800, 6, 6),
			bucket(3600, 6, 6),
		]);
		expect(empty).toContain("No measured response time in this window");
		expect(empty).toContain("no timing sample");
		expect(empty).not.toContain("bt-latency");
		// one measured sample flips the gate — the chart mounts
		const measured = renderTrends([
			bucket(1800, 6, 6),
			bucket(3600, 6, 6, 120, 1),
		]);
		expect(measured).toContain("bt-latency");
	});

	test("sparse table explains the — cells", () => {
		// total < 12 routes: the raster + table render, and a failure-only
		// bucket's Avg response is "—", never a 0 ms readout
		const text = renderTrends([
			bucket(1800, 3, 3),
			bucket(3600, 4, 4, 120, 4),
		]);
		expect(text).toContain(
			"Avg response “—” means no measured duration",
		);
		// the failure-only row renders "—"; the measured row renders its ms
		expect(text).toContain("<td>—</td>");
		expect(text).toContain("<td>120 ms</td>");
	});
});

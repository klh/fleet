// test/dashboard-fleet-ui.e2e.ts — W2269.1.2: the unified fleet table's
// Lit renderer (bin/dashboard-fleet.js, retired from the string-PAGE
// renderFleet()) asserted on the REAL component render, not source text —
// same harness shape as metrics-coverage-ui.e2e.ts: the chunk is imported
// into a sandbox with stubbed sibling modules, captured through the
// customElements shim, and render() is walked to text with a fixture
// /api/status snapshot.
import { expect, test } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin");
const defined = new Map<string, unknown>();

let sandbox = "";

interface FleetRow {
	port: number;
	state_label: string;
	up: boolean;
	protocol: string;
	model_served: string | null;
	engine: string;
	ram_gb: number | null;
	tier?: string;
	good_at: string;
	calls?: number;
	errors?: number;
	avg_ms?: number | null;
	last_used?: string | null;
	last_error?: string | null;
	load_5m?: number;
}

function statusDoc(rows: FleetRow[], router: Partial<FleetRow> = {}) {
	return {
		ts: "2026-11-01T09:00:00Z",
		router: {
			up: true,
			port: 4000,
			state_label: "ok",
			protocol: "anthropic",
			engine: "bun",
			ram_gb: null,
			good_at: "routing",
			model_served: null,
			...router,
		},
		specialists: rows,
		routing_tail: [],
	};
}

test.describe("belt fleet table render", () => {
	test.beforeAll(async () => {
		sandbox = mkdtempSync(join(tmpdir(), "belt-fleet-ui-"));
		mkdirSync(join(sandbox, "vendor"));
		cpSync(
			join(BIN, "dashboard-fleet.js"),
			join(sandbox, "dashboard-fleet.js"),
		);
		cpSync(join(BIN, "vendor", "lit.js"), join(sandbox, "vendor", "lit.js"));
		writeFileSync(
			join(sandbox, "register.js"),
			`export const defineElement = (tag, ctor) => { globalThis.__defined?.(tag, ctor); };
export const registeredTags = () => [];`,
		);
		const g = globalThis as unknown as {
			customElements?: {
				define(name: string, ctor: unknown): void;
				get(name: string): unknown;
			};
			HTMLElement?: unknown;
			document?: unknown;
			__defined?: (tag: string, ctor: unknown) => void;
		};
		g.__defined = (tag, ctor) => defined.set(tag, ctor);
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
		// the REAL chunk import — register.js and vendor/lit.js are satisfied
		// above; belt-fleet-table is captured through the customElements shim
		// and lifecycle rendering (which needs a DOM) stays off — the tests
		// drive render() directly
		await import(join(sandbox, "dashboard-fleet.js"));
	});

	test.afterAll(() => {
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

	function makeTable() {
		const ctor = defined.get("belt-fleet-table") as new () => {
			status: unknown;
			localName: string;
			render(): unknown;
		};
		const el = new ctor();
		el.localName = "mac";
		return el;
	}

	test("one disclosure row per router + specialist with byte-stable cells @unit", () => {
		const el = makeTable();
		const doc = statusDoc([
			{
				port: 8901,
				state_label: "ok",
				up: true,
				protocol: "openai",
				model_served: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
				engine: "mlx_lm",
				ram_gb: 18,
				tier: "resident",
				good_at: "code",
				calls: 12,
				errors: 0,
				avg_ms: 812,
				last_used: "2026-11-01T08:59:00Z",
			},
		]);
		el.status = doc;
		const raw = el.render();
		const text = renderToText(raw);
		// router row first, specialist second — the retired renderer's order
		expect(text.indexOf(":4000")).toBeLessThan(text.indexOf(":8901"));
		expect(text).toContain("mac");
		expect(text).toContain('<span class="u">(local)</span>');
		expect(text).toContain("Qwen3-Coder-30B-A3B-Instruct-4bit");
		// mlx-community/ prefix is stripped in the model cell, kept in title
		expect(text).not.toContain(">mlx-community/");
		expect(text).toContain(
			"title=mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
		);
		expect(text).toContain("engine bun");
		expect(text).toContain("engine mlx_lm");
		expect(text).toContain("tier resident");
		expect(text).toContain("18 GB ram");
		expect(text).toContain("12 calls");
		expect(text).toContain("avg 812ms");
		expect(text).toContain("0 errors");
		// the panel line renders "good at:" then the value as sibling parts
		expect(text).toContain("good at:</span> code");
		expect(text).toContain('class="frow"');
	});

	test("down specialist renders the muted state and no memory panel @unit", () => {
		const el = makeTable();
		el.status = statusDoc([
			{
				port: 8906,
				state_label: "idle",
				up: false,
				protocol: "openai",
				model_served: null,
				engine: "mlx_lm",
				ram_gb: 5,
				good_at: "danish",
			},
		]);
		const text = renderToText(el.render());
		expect(text).toContain('class="mut"');
		expect(text).toContain("idle");
		expect(text).toContain("—");
		expect(text).not.toContain("mrow");
		expect(text).toContain("5 GB");
	});

	test("load chip renders only above zero; last error rides the panel @unit", () => {
		const busy = makeTable();
		busy.status = statusDoc([
			{
				port: 8902,
				state_label: "ok",
				up: true,
				protocol: "openai",
				model_served: "Qwen3-4B-Instruct-2507-4bit",
				engine: "mlx_lm",
				ram_gb: 2.5,
				good_at: "extract",
				load_5m: 1.4,
				last_error: "boom",
			},
		]);
		const text = renderToText(busy.render());
		expect(text).toContain('class="load"');
		expect(text).toContain("1.4/5m");
		expect(text).toContain("last error: boom");

		const idle = makeTable();
		idle.status = statusDoc([
			{
				port: 8903,
				state_label: "ok",
				up: true,
				protocol: "openai",
				model_served: "Qwen3.5-35B-A3B-4bit",
				engine: "mlx_lm",
				ram_gb: 20,
				good_at: "reason",
				load_5m: 0,
			},
		]);
		expect(renderToText(idle.render())).not.toContain('class="load"');
	});

	test("empty status renders nothing — the shell owns the headers @unit", () => {
		const el = makeTable();
		el.status = null;
		expect(renderToText(el.render())).toBe("");
	});
});

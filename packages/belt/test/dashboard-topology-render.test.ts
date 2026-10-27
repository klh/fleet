import { describe, expect, test } from "bun:test";

// bun ships no DOM: lit's vendored build reads HTMLElement/document at
// module-eval time and the module tail registers the custom element. Stub all
// three inertly — machine() itself only reads prototype methods plus
// this.expandedHubs, never the DOM.
class HTMLElementStub {}
const globals = globalThis as Record<string, unknown>;
globals.HTMLElement ??= HTMLElementStub;
globals.document ??= { createTreeWalker: () => ({}) };
globals.customElements ??= { define() {}, get: () => undefined };

const { BeltTopology } = await import("../bin/dashboard-topology.js");

const flattenValues = (value) =>
	Array.isArray(value)
		? value.flatMap(flattenValues)
		: value && typeof value === "object" && Array.isArray(value.values)
			? flattenValues(value.values)
			: [value];

// W1223 regression: the non-gateway exposed-model arm never set `ports`, so
// any hub card carrying a model outside the gateway route set threw
// "Cannot read properties of undefined (reading 'length')" mid-render and the
// whole Connections map failed to paint on live-board data.
describe("belt topology hub-card render", () => {
	test("paints a hub card whose models sit outside the gateway route set", () => {
		const card = Object.create(BeltTopology.prototype);
		card.expandedHubs = new Set(["hub:nas"]);
		const models = [
			{ model: "hub-only-model", state: "unknown", requests15: null },
			{ model: "second-hub-model", state: "unknown", requests15: 3 },
		];
		const paint = () =>
			card.machine(
				430,
				65,
				275,
				320,
				"NAS hub",
				":8101 · up probe",
				"up",
				models,
				false,
				null,
				null,
				["cloud-model"],
				{},
				"hub:nas",
				{},
				1,
				[],
				{},
				[],
				{},
				[],
			);
		const result = paint();
		expect(result).toBeTruthy();
		expect(() => paint()).not.toThrow();
		expect(flattenValues(result)).toContain("hub-only-model");
		expect(flattenValues(result)).toContain("second-hub-model");
	});
});

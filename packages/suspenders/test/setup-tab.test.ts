import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { TABS } from "../hooks/board-html/tabs.ts";

describe("setup activation", () => {
	test("direct setup hash and returning to Setup request fresh checks", () => {
		let requests = 0;
		let hash = "#setup";
		const sections = new Map<string, { hidden: boolean }>();
		const context = {
			curTab: "decisions",
			TABS: { decisions: 1, setup: 1 },
			location: {
				get hash() {
					return hash;
				},
				set hash(value: string) {
					hash = value.startsWith("#") ? value : `#${value}`;
				},
			},
			document: {
				querySelector: () => ({ querySelectorAll: () => [] }),
			},
			byId: (id: string) => {
				if (!sections.has(id)) sections.set(id, { hidden: true });
				return sections.get(id);
			},
			pollSetup: () => requests++,
			pollHist: () => {},
			renderSetup: () => {},
			renderHist: () => {},
		};
		// Execute the actual tab-shell functions, without unrelated event wiring.
		runInNewContext(
			`${TABS.split("// --- wiring ---")[0]}\nsetTab('setup', true);`,
			context,
		);
		expect(requests).toBe(1);
		expect(sections.get("tab-setup")?.hidden).toBe(false);
		expect(sections.get("tab-decisions")?.hidden).toBe(true);
		runInNewContext("setTab('decisions'); setTab('setup');", context);
		expect(requests).toBe(2);
		expect(context.location.hash).toBe("#setup");
	});
});

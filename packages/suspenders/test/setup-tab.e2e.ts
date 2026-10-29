import { expect, test } from "./pw";
import { runInNewContext } from "node:vm";
import { TABS } from "../hooks/board-html/tabs.ts";
// W858.7.21: the Setup client chunk — grouped checklist rendering.
import { SETUP } from "../hooks/board-html/setup.ts";

test.describe("setup activation", () => {
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

// W858.7.21 harness: run the SETUP client chunk against DOM stubs and
// capture the sigSet payload renderSetup builds.
function runSetupRender(checks: Record<string, unknown>[]): string {
	const captured: { html?: string } = {};
	runInNewContext(`${SETUP}\nrenderSetup();`, {
		esc: (s: unknown) => String(s),
		byId: () => ({}),
		setText: () => {},
		clearErr: () => {},
		errBanner: () => {},
		sigSet: (_el: unknown, _sig: unknown, html: string) => {
			captured.html = html;
		},
		setupData: { checks },
		setupOkAt: 123,
		setupLoaded: true,
		setupErr: null,
	});
	return captured.html ?? "";
}

test.describe("W858.7.21 setup checklist grouping", () => {
	test("local wiring vs remote reachability, no check hidden", () => {
		const html = runSetupRender([
			{ id: "llm", label: "Advice LLM endpoint", ok: false, detail: "x", fix: "local LLM stack docs" },
			{ id: "db", label: "Control-plane database", ok: true, detail: "d", fix: null },
			{ id: "hubs", label: "Hub reachability", ok: false, detail: "nas no answer at http://127.0.0.1:9", fix: "bun deploy/hubctl.ts status nas" },
			{ id: "bind", label: "LAN binding", ok: true, detail: "127.0.0.1", fix: null },
		]);
		expect(html).toContain('sgroup">Local wiring <span class="dim">(2)</span>');
		expect(html).toContain('sgroup">Remote reachability <span class="dim">(2)</span>');
		// every check renders exactly once — none hidden, none duplicated
		for (const label of [
			"Advice LLM endpoint",
			"Control-plane database",
			"Hub reachability",
			"LAN binding",
		]) {
			const first = html.indexOf(label);
			expect(first).toBeGreaterThanOrEqual(0);
			expect(html.indexOf(label, first + 1)).toBe(-1);
		}
		// the failed hub card carries the concrete recovery command
		expect(html).toContain("bun deploy/hubctl.ts status nas");
	});
});

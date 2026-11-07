import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
// W858.7.21: the Setup family — grouped checklist (KlhSetup leaf pins) +
// the tab shell's setup kick (the feed is mediator-defined now; the shell
// kicks it by name, the decisions-hist precedent).
import { setupGroups } from "../hooks/board-html/klh-setup.ts";
import type { SetupCheck } from "../hooks/board-html/setup-slice.ts";
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
			window: { scrollTo: () => {} },
			byId: (id: string) => {
				if (!sections.has(id))
					// parentElement: setTab toggles the search label's wrapper
					sections.set(id, { hidden: true, parentElement: { hidden: true } });
				return sections.get(id);
			},
			feeds: {
				kick: (name: string) => {
					if (name === "setup") requests++;
				},
			},
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

describe("W858.7.21 setup checklist grouping", () => {
	test("local wiring vs remote reachability, no check hidden", () => {
		const checks: SetupCheck[] = [
			{
				id: "llm",
				label: "Advice LLM endpoint",
				ok: false,
				detail: "x",
				fix: "local LLM stack docs",
			},
			{
				id: "db",
				label: "Control-plane database",
				ok: true,
				detail: "d",
				fix: null,
			},
			{
				id: "hubs",
				label: "Hub reachability",
				ok: false,
				detail: "nas no answer at http://127.0.0.1:9",
				fix: "bun deploy/hubctl.ts status nas",
			},
			{
				id: "bind",
				label: "LAN binding",
				ok: true,
				detail: "127.0.0.1",
				fix: null,
			},
		];
		const { local, remote } = setupGroups(checks);
		expect(local.map((c) => c.label)).toEqual([
			"Control-plane database",
			"LAN binding",
		]);
		expect(remote.map((c) => c.label)).toEqual([
			"Advice LLM endpoint",
			"Hub reachability",
		]);
		// every check renders exactly once — none hidden, none duplicated
		expect(local.length + remote.length).toBe(checks.length);
		// the failed hub card carries the concrete recovery command
		const hubs = remote.find((c) => c.label === "Hub reachability");
		expect(hubs?.fix).toBe("bun deploy/hubctl.ts status nas");
	});
});

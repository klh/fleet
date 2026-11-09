import { expect, test } from "@playwright/test";

test("Pi panel distinguishes reachable catalogs from inference and preserves narrow terminals @unit", async () => {
	const { renderSnapshot } = await import(
		"../pi-extensions/fleet-awareness/presentation.ts"
	);
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const snapshot = {
		hubs: {
			state: "ok" as const,
			observedAt: 1000,
			value: [
				{
					label: "fixture",
					up: true,
					url: "http://fixture.invalid",
					models: null,
					candidates: [],
				},
			],
		},
		work: { state: "unavailable" as const, observedAt: 1000, value: null },
		peers: { state: "ok" as const, observedAt: 1000, value: [] },
	};
	const lines = renderSnapshot(snapshot, "routes", 90, 1000);
	expect(lines.join("\n")).toContain("reachable");
	expect(lines.join("\n")).toContain("catalog unknown");
	expect(lines.join("\n")).not.toContain("inference healthy");
	const narrow = renderSnapshot(snapshot, "routes", 18, 100_000);
	expect(narrow.every((line) => visibleWidth(line) <= 18)).toBe(true);
	expect(narrow.join("\n")).toContain("STALE");
});

test("Pi panel switches tabs, refreshes explicitly and releases redraw timer on escape @unit", async () => {
	const { openFleet } = await import(
		"../pi-extensions/fleet-awareness/panel.ts"
	);
	const { Key } = await import("@earendil-works/pi-tui");
	let refreshes = 0,
		renders = 0;
	const snapshot = {
		hubs: { state: "ok" as const, observedAt: Date.now(), value: [] },
		work: {
			state: "unavailable" as const,
			observedAt: Date.now(),
			value: null,
		},
		peers: { state: "ok" as const, observedAt: Date.now(), value: [] },
	};
	type Panel = {
		render(width: number): string[];
		handleInput(data: string): void;
	};
	type Factory = (
		tui: { requestRender(): void },
		theme: { fg(color: string, text: string): string },
		bindings: { matches(data: string, key: string): boolean },
		done: (value: unknown) => void,
	) => Panel;
	const ctx = {
		cwd: "/fixture",
		hasUI: true,
		ui: {
			custom: async (factory: Factory) => {
				let result: unknown;
				const panel = factory(
					{
						requestRender: () => {
							renders++;
						},
					},
					{ fg: (_color, text) => text },
					{ matches: (data) => data === Key.escape },
					(value) => {
						result = value;
					},
				);
				expect(panel.render(100)[0]).toContain("[1 OVERVIEW]");
				expect(panel.render(100)[2]).toContain("OVERVIEW");
				panel.handleInput("\u001b[C");
				expect(panel.render(100)[0]).toContain("[2 WORK]");
				panel.handleInput("3");
				expect(panel.render(100)[2]).toContain("ROUTES");
				panel.handleInput("r");
				await Promise.resolve();
				panel.handleInput(Key.escape);
				return result;
			},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
	await openFleet(
		"",
		ctx,
		() => snapshot,
		async () => {
			refreshes++;
		},
		async () => {
			throw new Error("unexpected model or CLI call");
		},
		null,
	);
	expect(refreshes).toBe(1);
	const before = renders;
	await new Promise((resolve) => setTimeout(resolve, 1050));
	expect(renders).toBe(before);
});

test("Pi panel captures navigation while its first Fleet read is pending @unit", async () => {
	const { openFleet } = await import(
		"../pi-extensions/fleet-awareness/panel.ts"
	);
	const { Key, visibleWidth } = await import("@earendil-works/pi-tui");
	const pending = Promise.withResolvers<void>();
	let renders = 0;
	const ctx = {
		cwd: "/fixture",
		hasUI: true,
		ui: {
			custom: async (
				factory: (
					tui: { requestRender(): void },
					theme: { fg(color: string, text: string): string },
					bindings: { matches(data: string): boolean },
					done: (value: null) => void,
				) => {
					render(width: number): string[];
					handleInput(data: string): void;
				},
			) => {
				const closed = Promise.withResolvers<null>();
				const panel = factory(
					{
						requestRender: () => {
							renders++;
						},
					},
					{ fg: (_color, text) => text },
					{ matches: (data) => data === Key.escape },
					closed.resolve,
				);
				await Promise.resolve();
				expect(panel.render(80)[2]).toContain("SYNCING");
				panel.handleInput("3");
				expect(panel.render(80)[2]).toContain("ROUTES");
				expect(panel.render(22).every((line) => visibleWidth(line) <= 22)).toBe(
					true,
				);
				panel.handleInput(Key.escape);
				return closed.promise;
			},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
	await openFleet(
		"",
		ctx,
		() => null,
		() => pending.promise,
		async () => {
			throw new Error("unexpected CLI call");
		},
		null,
	);
	const before = renders;
	pending.resolve();
	await Promise.resolve();
	expect(renders).toBe(before);
});

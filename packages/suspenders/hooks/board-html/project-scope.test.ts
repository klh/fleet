import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CORE } from "./core.ts";
import { BOOT } from "./boot.ts";
import { TASKS } from "./tasks.ts";
import { ACTIVITY } from "./activity.ts";

function fixture(href: string) {
	const options = [{ value: "all", textContent: "all projects" }];
	const select = {
		value: "all",
		options,
		remove(index: number) {
			options.splice(index, 1);
		},
		appendChild(option: { value: string; textContent: string }) {
			options.push(option);
		},
	};
	const context = {
		URL,
		location: { href },
		sel: select,
		knownProj: {},
		document: { createElement: () => ({ value: "", textContent: "" }) },
		history: {
			replaceState: (_state: unknown, _title: string, url: string) => {
				context.location.href = new URL(url, context.location.href).href;
			},
		},
	};
	runInNewContext(CORE, context);
	return context as typeof context & {
		projectFromUrl(): string;
		selectProject(p: string): void;
		noteProjects(p: string[]): void;
		writeProjectUrl(): void;
		projQuery(): string;
	};
}

test("URL selects an empty project before it appears in the graph", () => {
	const c = fixture(
		"https://suspenders.local/?project=%2Fdemo%2F.git#decisions",
	);
	c.selectProject(c.projectFromUrl());
	expect(c.sel.value).toBe("/demo/.git");
	expect(c.projQuery()).toBe("?project=%2Fdemo%2F.git");
	c.noteProjects(["/unrelated/.git"]);
	expect(c.sel.value).toBe("/demo/.git");
});

test("scope URL preserves active view and other parameters", () => {
	const c = fixture("https://suspenders.local/?other=keep#lanes");
	c.selectProject("/demo/.git");
	c.writeProjectUrl();
	expect(c.location.href).toBe(
		"https://suspenders.local/?other=keep&project=%2Fdemo%2F.git#lanes",
	);
	c.selectProject("all");
	c.writeProjectUrl();
	expect(c.location.href).toBe("https://suspenders.local/?other=keep#lanes");
});

test("URL scope is established before any boot poll", () => {
	expect(BOOT.indexOf("selectProject(projectFromUrl())")).toBeLessThan(
		BOOT.indexOf("setTab("),
	);
	expect(BOOT.indexOf("selectProject(projectFromUrl())")).toBeLessThan(
		BOOT.indexOf("tick();"),
	);
});

test("late responses from another project cannot repopulate tasks or activity", async () => {
	for (const [source, poll, payload] of [
		[TASKS, "pollTasks", { tasks: [] }],
		[ACTIVITY, "pollAct", { events: [] }],
	] as const) {
		let release: (value: unknown) => void = () => {};
		const response = new Promise((resolve) => {
			release = resolve;
		});
		let scope = "?project=old";
		let calls = 0;
		const c: Record<string, unknown> = {
			tasksBusy: false,
			actBusy: false,
			curTab: poll === "pollTasks" ? "lanes" : "activity",
			localStorage: { getItem: () => null },
			document: {},
			AbortSignal,
			projQuery: () => scope,
			fetch: () => (++calls === 1 ? response : new Promise(() => {})),
			renderTasks: () => {},
			renderKanban: () => {},
			renderAct: () => {},
			noteProjects: () => {},
			tasksData: null,
			actData: null,
			tasksLoaded: false,
			actLoaded: false,
		};
		runInNewContext(
			`${source}\nrenderTasks = function(){}; renderKanban = function(){}; renderAct = function(){};`,
			c,
		);
		c.renderTasks = () => {};
		c.renderKanban = () => {};
		c.renderAct = () => {};
		(c[poll] as () => void)();
		scope = "?project=new";
		release({
			ok: true,
			json: async () => ({ ...payload, projects: ["old"] }),
		});
		await Bun.sleep(5);
		expect(c.tasksData).toBeNull();
		expect(c.actData).toBeNull();
	}
});

import { describe, expect, test } from "bun:test";
import {
	selectGovernorCompletions,
	selectGovernorLanes,
} from "./fleet-lane-view.ts";
import { RENDERS } from "./renders.ts";

const lane = (
	sid: string,
	hbAgo: number,
	state = "RUNNING",
	project: string | null = "/fleet/.git",
) => ({ sid, hbAgo, state, project });

describe("Governor lane overview", () => {
	test("does not count stale RUNNING records as current activity", () => {
		const view = selectGovernorLanes(
			[
				lane("old", 86400),
				lane("quiet", 10, "CLOSED"),
				lane("running", 60),
				lane("waiting", 120, "WAITING"),
				lane("unknown", -1),
			],
			"all",
		);
		expect(view.current.map((s) => s.sid)).toEqual(["running", "waiting"]);
		expect(view.recent.map((s) => s.sid)).toEqual([
			"running",
			"waiting",
			"quiet",
		]);
		expect(view.history.map((s) => s.sid)).toEqual(["old", "unknown"]);
	});

	test("scopes current, recent and historical records to the selected project", () => {
		const view = selectGovernorLanes(
			[
				lane("ours", 5),
				lane("other", 1, "RUNNING", "/other/.git"),
				lane("unknown-project", 1, "RUNNING", null),
				lane("our-old", 5000),
				lane("other-old", 5000, "CLOSED", "/other/.git"),
			],
			"/fleet/.git",
		);
		expect(view.current.map((s) => s.sid)).toEqual(["ours"]);
		expect(view.history.map((s) => s.sid)).toEqual(["our-old"]);
	});

	test("the browser serialization has no module dependencies", () => {
		const browserSelector = new Function(
			`return (${selectGovernorLanes.toString()});`,
		)();
		expect(browserSelector([lane("a", 300), lane("b", 3601)], "all")).toEqual(
			selectGovernorLanes([lane("a", 300), lane("b", 3601)], "all"),
		);
	});
});

/** Minimal DOM boundary lets the served script run without a browser dependency. */
class Element {
	children: Element[] = [];
	textContent = "";
	id = "";
	style = { display: "block" };
	open = false;
	hidden = false;
	disabled = false;
	listeners: Record<string, () => void> = {};
	constructor(public tag = "div") {}
	appendChild(child: Element) {
		this.children.push(child);
		return child;
	}
	replaceChildren(...children: Element[]) {
		this.children =
			children[0]?.tag === "fragment" ? children[0].children : children;
	}
	addEventListener(kind: string, listener: () => void) {
		this.listeners[kind] = listener;
	}
	querySelector(tag: string): Element | undefined {
		return this.children.find((child) => child.tag === tag);
	}
}

test("served overview bounds history and filters it without inserting HTML", () => {
	const roots = Object.fromEntries(
		["fleetBody", "fleetLine", "stamp", "blockedn"].map((id) => [
			id,
			new Element(),
		]),
	);
	const byId = (id: string): Element | undefined => {
		const visit = (el: Element): Element | undefined => {
			if (el.id === id) return el;
			for (const child of el.children) {
				const found = visit(child);
				if (found) return found;
			}
		};
		return roots[id] || Object.values(roots).map(visit).find(Boolean);
	};
	const document = {
		createElement: (tag: string) => new Element(tag),
		createDocumentFragment: () => new Element("fragment"),
		createTextNode: (text: string) =>
			Object.assign(new Element("text"), { textContent: text }),
	};
	const data = {
		ts: Date.now(),
		sessions: [
			{ ...lane("fresh", 1), label: "<img onerror=bad()>" },
			lane("other-project", 1, "RUNNING", "/other/.git"),
			...Array.from({ length: 120 }, (_, i) => lane(`old-${i}`, 5000 + i)),
		],
		projects: [
			{ project: "/fleet/.git", gated: [1] },
			{ project: "/other/.git", gated: [1, 2] },
		],
	};
	const render = new Function(
		"document",
		"byId",
		"lastData",
		"sel",
		"setText",
		"openDecs",
		"ago",
		"stateLabel",
		"zombieFor",
		`${RENDERS}; return renderFleet;`,
	)(
		document,
		byId,
		data,
		{ value: "/fleet/.git" },
		(el: Element, text: string) => {
			el.textContent = text;
		},
		() => [],
		String,
		String,
		() => false,
	);
	render();
	expect(byId("fleetRecent")?.children).toHaveLength(1);
	expect(byId("fleetRecent")?.children[0].children[0].textContent).toBe(
		"<img onerror=bad()>",
	);
	expect(roots.fleetLine.textContent).toContain(
		"1 working · 0 waiting on you · 1 blocked",
	);
	expect(byId("fleetHistoryLanes")?.children).toHaveLength(0);
	const history = byId("fleetHistory");
	if (!history) throw new Error("Missing native history details");
	history.open = true;
	history.listeners.toggle();
	expect(byId("fleetHistoryLanes")?.children).toHaveLength(50);
	expect(byId("fleetHistoryRange")?.textContent).toBe("1–50 of 120");
	byId("fleetHistoryNext")?.listeners.click();
	expect(byId("fleetHistoryRange")?.textContent).toBe("51–100 of 120");
	expect(byId("fleetHistoryPrev")?.disabled).toBe(false);
});

test("recent completions have a single global bound and recency order", () => {
	const projects = ["ours", "other"].map((project, p) => ({
		project,
		done: Array.from({ length: 40 }, (_, i) => ({
			id: `${project}-${i}`,
			title: "completed",
			updatedAgo: i * 2 + p,
		})),
	}));
	const all = selectGovernorCompletions(projects, "all");
	expect(all).toHaveLength(30);
	expect(all.slice(0, 3).map((done) => done.id)).toEqual([
		"ours-0",
		"other-0",
		"ours-1",
	]);
	expect(
		selectGovernorCompletions(projects, "ours").every(
			(done) => done.project === "ours",
		),
	).toBe(true);
	const browserSelector = new Function(
		`return (${selectGovernorCompletions.toString()});`,
	)();
	expect(browserSelector(projects, "all")).toEqual(all);
});

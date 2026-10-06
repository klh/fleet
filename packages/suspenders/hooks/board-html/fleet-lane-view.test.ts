import { describe, expect, test } from "bun:test";
import {
	matchesHubScope,
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

test("hub scopes keep origin, immediate peer, unknown and expiry separate", () => {
	const scope = {
		origin: "spoke-a",
		peer: "team-a",
		now: 100,
		observations: [
			{
				laneId: "a",
				project: "/fleet/.git",
				originHub: "spoke-a",
				peerHub: "team-a",
				expiresAt: 200,
			},
			{
				laneId: "a",
				project: "/fleet/.git",
				originHub: "spoke-a",
				peerHub: "team-b",
				expiresAt: 200,
			},
			{
				laneId: "expired",
				project: "/fleet/.git",
				originHub: "spoke-a",
				peerHub: "team-a",
				expiresAt: 100,
			},
		],
	};
	expect(matchesHubScope("a", "/fleet/.git", scope)).toBe(true);
	expect(matchesHubScope("a", "/other/.git", scope)).toBe(false);
	expect(
		matchesHubScope("a", "/fleet/.git", { ...scope, origin: "team-a" }),
	).toBe(false);
	expect(
		matchesHubScope("a", "/fleet/.git", { ...scope, peer: "team-b" }),
	).toBe(true);
	expect(
		matchesHubScope("a", "/fleet/.git", {
			...scope,
			origin: "unknown",
			peer: "all",
		}),
	).toBe(false);
	expect(
		matchesHubScope("expired", "/fleet/.git", {
			...scope,
			origin: "unknown",
			peer: "unknown",
		}),
	).toBe(true);
	expect(
		matchesHubScope(null, null, { ...scope, origin: "unknown", peer: "all" }),
	).toBe(true);
	expect(
		selectGovernorLanes(
			[lane("a", 1), lane("unobserved", 2), lane("expired", 1)],
			"all",
			scope,
		).current.map((s) => s.sid),
	).toEqual(["a"]);
	const projects = [
		{
			project: "/fleet/.git",
			done: [
				{ id: "observed", title: "done", updatedAgo: 10, owner: "a" },
				{ id: "no-owner", title: "done", updatedAgo: 1, owner: null },
			],
		},
	];
	expect(
		selectGovernorCompletions(projects, "all", scope).map((d) => d.id),
	).toEqual(["observed"]);
	const browserSelector = new Function(
		"matchesHubScope",
		`return (${selectGovernorLanes.toString()});`,
	)(matchesHubScope);
	expect(
		browserSelector([lane("a", 1), lane("unobserved", 2)], "all", scope)
			.current,
	).toHaveLength(1);
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
	get childNodes() {
		return this.children;
	}
	setAttribute() {}
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

test("Governor claims and event rows use the same hub and project scope", () => {
	const roots = Object.fromEntries(
		["claims", "events", "filters"].map((id) => [id, new Element()]),
	);
	const document = {
		createElement: (tag: string) => new Element(tag),
		createDocumentFragment: () => new Element("fragment"),
		createTextNode: (text: string) =>
			Object.assign(new Element("text"), { textContent: text }),
	};
	const data = {
		sessions: [
			lane("ours", 1),
			lane("other", 1, "RUNNING", "/other/.git"),
			lane("unknown", 1),
		],
		laneObservations: {
			lanes: [
				{
					laneId: "ours",
					project: "/fleet/.git",
					originHub: "spoke",
					peerHub: "team",
					expiresAt: Date.now() + 60_000,
				},
			],
		},
		claims: ["ours", "other", "unknown"].map((sid) => ({
			sid,
			scope: "<hostile>",
			tsAgo: 1,
		})),
		events: ["ours", "other", "unknown"].map((source, id) => ({
			id,
			source,
			kind: "landed",
			tsAgo: 1,
		})),
	};
	const run = new Function(
		"document",
		"byId",
		"lastData",
		"sel",
		"ago",
		"agoShort",
		`var hubOrigin = 'spoke'; var hubPeer = 'team'; var evFilter = 'all'; ${RENDERS}; renderClaims(lastData); renderEvents(lastData);`,
	);
	run(
		document,
		(id: string) => roots[id],
		data,
		{ value: "/fleet/.git" },
		String,
		String,
	);
	expect(roots.claims.children).toHaveLength(1);
	expect(roots.claims.children[0].children[0].textContent).toBe("<hostile>");
	expect(roots.events.children).toHaveLength(1);
	expect(roots.events.children[0].children[1].textContent).toContain("ours");
});

test("header expires a snapshot even when the request was just received", () => {
	const attributes: Record<string, string> = {};
	const conn = {
		innerHTML: "",
		title: "",
		getAttribute: (key: string) => attributes[key],
		setAttribute: (key: string, value: string) => {
			attributes[key] = value;
		},
	};
	const now = Date.now();
	const data = {
		observation: {
			source: "board",
			target: "ledger",
			scope: "all",
			observedAt: now - 2000,
			expiresAt: now - 1,
		},
	};
	const render = new Function(
		"lastData",
		"byId",
		"ago",
		"esc",
		`var dataOkAt = Date.now(); var decOkAt = Date.now(); var dataErr = null; var decErr = null; var decLoaded = true; ${RENDERS}; renderConn();`,
	);
	render(data, (id: string) => (id === "conn" ? conn : null), String, String);
	expect(conn.innerHTML).toContain("stale snapshot");
	expect(conn.title).toContain("Source: board · target: ledger · scope: all");
	expect(conn.title).toContain("expires:");
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

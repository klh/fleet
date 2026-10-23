import { describe, expect, test } from "bun:test";
import { BODY } from "./body.ts";
import {
	matchesHubScope,
	selectGovernorCompletions,
	selectGovernorLanes,
} from "./fleet-lane-view.ts";
import { RENDERS } from "./renders.ts";

const fleetRenderScript = `function setNodes(el, text){ el.textContent = text; } function stLetter(){ return ''; } function esc(text){ return String(text); } ${RENDERS}; return renderFleet;`;

test("header explains gated work separately from the BLOCKED lane", () => {
	expect(BODY).toContain(
		'id="blockedn" title="Gated work items: READY with unmet dependencies, WAITING, BLOCKED, or PAUSED. The Lanes BLOCKED count uses its own display state."',
	);
	expect(BODY).toContain("</b> gated</span>");
});

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
		[
			"fleetBody",
			"fleetLine",
			"fleetWorking",
			"fleetWaiting",
			"fleetBlocked",
			"fleetRecentCount",
			"fleetContext",
			"stamp",
			"blockedn",
		].map((id) => [id, new Element()]),
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
		fleetRenderScript,
	)(
		document,
		byId,
		data,
		{ value: "/fleet/.git" },
		(el: Element | undefined, text: string) => {
			if (el) el.textContent = text;
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
		"0 live sessions · 0 waiting on you · 1 gated",
	);
	expect(roots.fleetBlocked.textContent).toBe(1);
	expect(roots.blockedn.textContent).toBe("1 gated");
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
test("history cap note reports sessionsTotal beyond the served cap (W685)", () => {
	const roots = Object.fromEntries(
		[
			"fleetBody",
			"fleetLine",
			"fleetWorking",
			"fleetWaiting",
			"fleetBlocked",
			"fleetRecentCount",
			"fleetContext",
			"stamp",
			"blockedn",
		].map((id) => [id, new Element()]),
	);
	const byId = (id: string): Element | undefined => {
		const visit = (el: Element): Element | undefined => {
			if (id === el.id) return el;
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
	const data: Record<string, unknown> = {
		ts: Date.now(),
		sessionsTotal: 500,
		projects: [],
		sessions: [
			lane("fresh", 1),
			...Array.from({ length: 120 }, (_, i) => lane(`old-${i}`, 5000 + i)),
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
		fleetRenderScript,
	)(
		document,
		byId,
		data,
		{ value: "all" },
		(el: Element | undefined, text: string) => {
			if (el) el.textContent = text;
		},
		() => [],
		String,
		String,
		() => false,
	);
	render();
	const history = byId("fleetHistory");
	if (!history) throw new Error("Missing native history details");
	history.open = true;
	history.listeners.toggle();
	expect(byId("fleetHistoryRange")?.textContent).toBe("1–50 of 120");
	expect(byId("fleetHistoryNote")?.textContent).toBe(
		"Oldest 380 not served — the board caps history at 120 lanes per feed.",
	);
	delete data.sessionsTotal;
	render();
	expect(byId("fleetHistoryNote")?.textContent).toBe("");
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
		markup: "",
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
		"setNodes",
		`var dataOkAt = Date.now(); var decOkAt = Date.now(); var dataErr = null; var decErr = null; var decLoaded = true; ${RENDERS}; renderConn();`,
	);
	render(
		data,
		(id: string) => (id === "conn" ? conn : null),
		String,
		String,
		(el: typeof conn, html: string) => {
			el.markup = html;
		},
	);
	expect(conn.markup).toContain("stale snapshot");
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

/** W1196: minimal served-script harness — renderFleet against hold rows only. */
const renderFleetHarness = (holds: unknown[], selValue = "all") => {
	const ids = [
		"fleetBody",
		"fleetLine",
		"fleetWorking",
		"fleetWaiting",
		"fleetBlocked",
		"fleetRecentCount",
		"fleetContext",
		"stamp",
		"blockedn",
	];
	const roots = Object.fromEntries(ids.map((id) => [id, new Element()]));
	const document = {
		createElement: (tag: string) => new Element(tag),
		createDocumentFragment: () => new Element("fragment"),
		createTextNode: (text: string) =>
			Object.assign(new Element("text"), { textContent: text }),
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
		fleetRenderScript,
	)(
		document,
		(id: string) => {
			const visit = (el: Element): Element | undefined =>
				el.id === id ? el : el.children.map(visit).find(Boolean);
			return roots[id] ?? Object.values(roots).map(visit).find(Boolean);
		},
		{ ts: 0, sessions: [], projects: [], dispatchHolds: holds },
		{ value: selValue },
		(el: Element | undefined, text: string) => {
			if (el) el.textContent = text;
		},
		() => [],
		String,
		String,
		() => false,
	);
	return { render, roots };
};

test("fleet line names the hold holder, reason and expiry (W1196)", () => {
	const { render, roots } = renderFleetHarness([
		{
			project: "/fleet/.git",
			by: "operator@mac",
			reason: "deploy freeze",
			set_at: "2026-10-23T08:00:00.000Z",
			expires_at: "2026-10-23T12:00:00.000Z",
			remaining_min: 240,
			legacy: false,
		},
		{
			project: "/other/.git",
			by: "(legacy marker)",
			reason: "bare dispatch-paused file",
			set_at: "",
			expires_at: null,
			remaining_min: null,
			legacy: true,
		},
	]);
	render();
	expect(roots.fleetLine.textContent).toContain(
		"hold by operator@mac — deploy freeze · expires 2026-10-23T12:00:00.000Z (240 min left)",
	);
	expect(roots.fleetLine.textContent).toContain("+1 more hold(s)");
	expect(roots.fleetContext.textContent).toBe(
		"Live = RUNNING with a heartbeat within 5 min; claimed work is on Tasks   ·   Dispatch hold by operator@mac · expires 2026-10-23T12:00:00.000Z · deploy freeze",
	);
});

test("hold lines scope to the selected project", () => {
	const foreign = renderFleetHarness(
		[
			{
				project: "/other/.git",
				by: "elsewhere",
				reason: "other tree",
				set_at: "2026-10-23T08:00:00.000Z",
				expires_at: "2026-10-23T12:00:00.000Z",
				remaining_min: 240,
				legacy: false,
			},
		],
		"/fleet/.git",
	);
	foreign.render();
	expect(foreign.roots.fleetLine.textContent).not.toContain("hold by");
});

test("legacy holds render without an expiry (W1196)", () => {
	const legacy = renderFleetHarness(
		[
			{
				project: "/other/.git",
				by: "(legacy marker)",
				reason: "bare dispatch-paused file",
				set_at: "",
				expires_at: null,
				remaining_min: null,
				legacy: true,
			},
		],
		"/other/.git",
	);
	legacy.render();
	expect(legacy.roots.fleetLine.textContent).toContain(
		"hold by (legacy marker) — bare dispatch-paused file · legacy marker, no expiry",
	);
	expect(legacy.roots.fleetLine.textContent).not.toContain("min left");
	expect(legacy.roots.fleetContext.textContent).toContain("legacy bare marker");
});

// test/board-hash-params.test.ts — W890: query-style tab-hash deep links
// (#lanes?w=<id> selects + opens the drawer; ?project/?q on any tab hash).
// The router functions eval from the shipped CORE chunk bytes with page
// globals injected; page-level asserts cover the wiring + highlight CSS.
import { describe, expect, test } from "bun:test";
import { BOOT } from "../hooks/board-html/boot.ts";
import { CORE } from "../hooks/board-html/core.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";

type RouterCalls = {
	tabs: [string, boolean][];
	opened: [string, string | null][];
	warns: string[];
	scoped: string[];
	kclass: string;
	scrolled: number;
};

function cardStubs(
	calls: RouterCalls,
	cards?: { kid: string; kproj?: string }[],
) {
	return (cards ?? []).map((c) => ({
		getAttribute: (n: string) => (n === "data-kid" ? c.kid : (c.kproj ?? "")),
		classList: {
			add: (cls: string) => {
				calls.kclass = cls;
			},
		},
		scrollIntoView: () => {
			calls.scrolled++;
		},
	}));
}

function fakeSelect(calls: RouterCalls, options?: string[]) {
	const selEl = {
		value: "all",
		options: (options ?? ["all", "/repo/.git", "/other/.git"]).map(
			(v) => ({ value: v }),
		),
		dispatchEvent: (e: Event) => {
			if (e.type === "change") calls.scoped.push(selEl.value);
		},
	};
	return selEl;
}

function router(opts: {
	hash?: string;
	cards?: { kid: string; kproj?: string }[];
	options?: string[];
} = {}) {
	const calls: RouterCalls = {
		tabs: [],
		opened: [],
		warns: [],
		scoped: [],
		kclass: "",
		scrolled: 0,
	};
	const fn = new Function(
		"location",
		"TABS",
		"setTab",
		"openTask",
		"sel",
		"projShort",
		"curTab",
		"console",
		"document",
		`${CORE}\nreturn { parseHashQuery, hashNeedle, applyHashRoute, applyHashProject, scopeProjectSelect, applyHashItem, trySelectCard, pending: () => ({ pendingProj, pendingSelect }) };`,
	);
	const selEl = fakeSelect(calls, opts.options);
	const doc = {
		getElementById: (id: string) =>
			id === "kanban"
				? { querySelectorAll: () => cardStubs(calls, opts.cards) }
				: null,
	};
	const sandbox = fn(
		{ hash: opts.hash ?? "#decisions" },
		{ lanes: 1, tasks: 1, decisions: 1 },
		(id: string, fromHash: boolean) => calls.tabs.push([id, fromHash]),
		(id: string, proj: string | null) => calls.opened.push([id, proj]),
		selEl,
		(p: string) => p.replace(/\/\.git$/, "").split("/").pop(),
		"lanes",
		{ warn: (...a: unknown[]) => calls.warns.push(a.join(" ")) },
		doc,
	);
	return { sandbox, calls, selEl };
}

describe("parseHashQuery", () => {
	test("splits tab + params, decodes %XX, first occurrence wins", () => {
		const { sandbox } = router();
		const r = sandbox.parseHashQuery("#lanes?w=W179.2&project=fleet&z=1&z=2");
		expect(r.tab).toBe("lanes");
		expect(r.params).toEqual({ w: "W179.2", project: "fleet", z: "1" });
		const bad = sandbox.parseHashQuery("#tasks?q=deep%20link&x=%zz");
		expect(bad.params.q).toBe("deep link");
		// bad %XX escape survives verbatim (safeDecode fallback)
		expect(bad.params.x).toBe("%zz");
	});

	test("legacy no-? hashes never reach the parser", () => {
		const { sandbox } = router();
		expect(sandbox.parseHashQuery("#task=W1&proj=/r/.git").params).toEqual({});
		expect(sandbox.parseHashQuery("#filter=abc").params).toEqual({});
	});
});

describe("hashNeedle (?q / ?filter on any tab hash + legacy #filter=)", () => {
	const at = (h: string) => router({ hash: h }).sandbox.hashNeedle();
	test("legacy form, new keys, empty clears", () => {
		expect(at("#filter=abc")).toBe("abc");
		expect(at("#tasks?q=deep")).toBe("deep");
		expect(at("#lanes?filter=x%20y")).toBe("x y");
		expect(at("#tasks")).toBe("");
	});
});

describe("applyHashRoute — #lanes?w=<id>", () => {
	test("switches to lanes, opens the drawer, marks the card", () => {
		const { sandbox, calls } = router({ hash: "#lanes?w=W179.2", cards: [{ kid: "W179.2", kproj: "/repo/.git" }] });
		sandbox.applyHashRoute();
		expect(calls.tabs).toEqual([["lanes", true]]);
		expect(calls.opened).toEqual([["W179.2", null]]);
		expect(calls.kclass).toBe("ksel");
		expect(calls.scrolled).toBe(1);
		expect(sandbox.pending().pendingSelect?.applied).toBe(true);
		// a later render re-applies without scrolling again
		sandbox.trySelectCard();
		expect(calls.scrolled).toBe(1);
	});

	test("task= and id= aliases behave identically (proj= rides)", () => {
		const { sandbox, calls } = router({ hash: "#lanes?task=W1&proj=/r/.git", cards: [{ kid: "W1", kproj: "/r/.git" }] });
		sandbox.applyHashRoute();
		expect(calls.opened).toEqual([["W1", "/r/.git"]]);
		const b = router({ hash: "#lanes?id=W2", cards: [{ kid: "W2" }] });
		b.sandbox.applyHashRoute();
		expect(b.calls.opened).toEqual([["W2", null]]);
		expect(sandbox.pending().pendingSelect?.applied).toBe(true);
	});
});

describe("?project= scope selection", () => {
	test("alias and full path both select; unknown stashes pending", () => {
		const r = router({ hash: "#tasks?project=repo" });
		r.sandbox.applyHashRoute();
		expect(r.calls.scoped).toEqual(["/repo/.git"]);
		const full = router({ hash: "#tasks?project=/other/.git" });
		full.sandbox.applyHashRoute();
		expect(full.selEl.value).toBe("/other/.git");
		const miss = router({ hash: "#tasks?project=nowhere" });
		miss.sandbox.applyHashRoute();
		expect(miss.sandbox.pending().pendingProj).toBe("nowhere");
	});
});

describe("combined", () => {
	test("w + project", () => {
		const r = router({
			hash: "#lanes?w=W1&project=/repo/.git",
			cards: [{ kid: "W1", kproj: "/repo/.git" }],
			options: ["all", "/repo/.git"],
		});
		r.sandbox.applyHashRoute();
		expect(r.selEl.value).toBe("/repo/.git");
		expect(r.calls.opened).toEqual([["W1", null]]);
		expect(r.calls.kclass).toBe("ksel");
	});
});

describe("page-level asserts", () => {
	test("boot + hashchange route query hashes through applyHashRoute", () => {
		expect(BOOT).toContain("applyHashRoute();");
	});
	test("the .ksel highlight rides theme tokens", () => {
		expect(HTML).toContain(".kcard.ksel");
	});
});


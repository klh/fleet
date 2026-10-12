import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { CORE } from "../hooks/board-html/core.ts";

// W658.3 — the retired html-string sink: CORE's sigSet parses the (esc-
// assembled) fragment out-of-line and moves the nodes in; row fragments
// parse in table context. These tests drive the shipped chunk bytes with a
// stub DOMParser; real-parse behavior (identical DOM → probe contracts hold)
// is proven against a live board by e2e/hub-board.spec.ts.
type StubEl = {
	tagName: string;
	firstChild: StubEl | null;
	nextSibling: StubEl | null;
	firstElementChild: StubEl | null;
	getAttribute(k: string): string | null;
	setAttribute(k: string, v: string): void;
	replaceChildren(...n: StubEl[]): void;
	removeChild(n: StubEl): StubEl;
};

const leaf = (tagName: string): StubEl => ({
	tagName: tagName.toUpperCase(),
	firstChild: null,
	nextSibling: null,
	firstElementChild: null,
	getAttribute: () => null,
	setAttribute: () => {},
	replaceChildren: () => {},
	removeChild: () => {
		throw new Error("leaf nodes have no children");
	},
});

// parent whose children are linked via firstChild/nextSibling (and exposed
// through the firstElementChild alias sigSet reads)
const branch = (...kids: StubEl[]): StubEl => {
	const parent: StubEl = {
		tagName: "PARENT",
		firstChild: null,
		nextSibling: null,
		firstElementChild: null,
		getAttribute: () => null,
		setAttribute: () => {},
		replaceChildren: () => {},
		removeChild(n: StubEl) {
			if (parent.firstChild === n) parent.firstChild = n.nextSibling;
			parent.firstElementChild = parent.firstChild;
			return n;
		},
	};
	let prev: StubEl | null = null;
	for (const k of kids) {
		k.nextSibling = null;
		if (prev) prev.nextSibling = k;
		else parent.firstChild = k;
		prev = k;
	}
	parent.firstElementChild = parent.firstChild;
	return parent;
};

// drives the shipped CORE bytes; stub DOMParser mimics the two shapes
// sigSet consumes: div-wrapped fragment vs table/tbody row wrapper.
function client(el: StubEl, tagName = "DIV") {
	let parseCount = 0;
	let lastInput = "";
	el.tagName = tagName;
	const rootEl = branch(leaf("tr"), leaf("tr"));
	const divEl = branch(leaf("span"), leaf("b"), leaf("span"));
	rootEl.tagName = "TBODY";
	const table = branch(rootEl);
	table.tagName = "TABLE";
	divEl.tagName = "DIV";
	const ctx = {
		DOMParser: class {
			parseFromString(html: string, _type: string) {
				parseCount++;
				lastInput = html;
				return {
					body: {
						firstElementChild: html.startsWith("<table>") ? table : divEl,
					},
				};
			}
		},
		document: {},
		el,
	};
	runInContext(CORE, createContext(ctx));
	return {
		get parseCount() {
			return parseCount;
		},
		get lastInput() {
			return lastInput;
		},
		ctx,
	};
}

test("same sig never re-parses", () => {
	const el = branch(leaf("tr"));
	el.tagName = "TBODY";
	let sig: string | null = null;
	el.getAttribute = (k: string) => (k === "data-sig" ? sig : null);
	el.setAttribute = (k: string, v: string) => {
		if (k === "data-sig") sig = v;
	};
	let rendered = 0;
	el.replaceChildren = () => {
		rendered++;
	};
	const c = client(el, "TBODY");
	runInContext("sigSet(el, 's1', '<tr><td>x</td></tr>');", c.ctx);
	runInContext("sigSet(el, 's1', '<tr><td>x</td></tr>');", c.ctx);
	expect(c.parseCount).toBe(1);
	expect(rendered).toBe(1);
});

test("div context moves fragment nodes in under a div wrapper", () => {
	const el = branch();
	el.tagName = "DIV";
	const received: StubEl[] = [];
	el.replaceChildren = (...n: StubEl[]) => {
		received.push(...n);
	};
	const c = client(el);
	runInContext("sigSet(el, 'k1', '<span>a</span><b>c</b>');", c.ctx);
	expect(c.lastInput).toBe("<div><span>a</span><b>c</b></div>");
	expect(received.map((n) => n.tagName)).toEqual(["SPAN", "B", "SPAN"]);
});

test("tbody context parses rows in table context", () => {
	const el = branch();
	el.tagName = "TBODY";
	const received: StubEl[] = [];
	el.replaceChildren = (...n: StubEl[]) => {
		received.push(...n);
	};
	const c = client(el, "TBODY");
	runInContext("sigSet(el, 'r1', '<tr><td>a</td></tr>');", c.ctx);
	expect(c.lastInput.startsWith("<table><tbody>")).toBe(true);
	expect(c.lastInput.endsWith("</tbody></table>")).toBe(true);
	expect(received.map((n) => n.tagName)).toEqual(["TR", "TR"]);
});

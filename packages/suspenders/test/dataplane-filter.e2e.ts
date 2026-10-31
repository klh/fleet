// test/dataplane-filter.e2e.ts — W2326: exhaustive co-situated proof for the
// AIP-160 subset filter parser (hooks/lib/dataplane/filter.ts). Every case
// EXECUTES the emitted fragment against a real in-memory SQLite table —
// shape-only assertions cannot prove filter semantics. Error paths assert
// FilterError (and .field on unknown fields) so the service layer can map
// them to problem+json invalid_argument naming the field.

import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import {
	type FieldMap,
	FilterError,
	parseFilter,
	type SqlFragment,
} from "../hooks/lib/dataplane/filter.ts";

test.describe("@unit dataplane filter parser", () => {
	const fields: FieldMap = {
		state: { column: "state" },
		priority: { column: "priority", numeric: true },
		owner_sid: { column: "owner_sid" },
		tags: { column: "tags" },
		payload: { column: "payload", json: true },
	};

	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE items (id INTEGER PRIMARY KEY, state TEXT, priority INTEGER, owner_sid TEXT, tags TEXT, payload TEXT)",
	);
	const seed = (
		id: number,
		state: string,
		priority: number,
		owner: string,
		tags: string,
		payload: unknown,
	): void =>
		db
			.query(
				"INSERT INTO items (id, state, priority, owner_sid, tags, payload) VALUES (?,?,?,?,?,?)",
			)
			.run(id, state, priority, owner, tags, JSON.stringify(payload));
	seed(1, "READY", 0, null, "fleet,api", { kind: "work.added", n: 1 });
	seed(2, "CLAIMED", 1, "lane-a", "fleet", { kind: "work.claimed", n: 2 });
	seed(3, "DONE", 2, "lane-b", "api,design", { kind: "work.done", n: 3 });
	seed(4, "READY", 5, "lane-a", null, { kind: "work.added", n: 4 });
	// nested JSON payload — proves multi-segment dot-paths reach real rows
	seed(5, "FAILED", 0, "lane-c", null, { outer: { inner: "hit" } });
	// No db.close() teardown — bun:sqlite close hangs the playwright
	// bun-runtime worker after the last test; the :memory: db dies with it.

	/** Run the filter as a real WHERE clause; return matching ids ascending. */
	const selectIds = (filter: string): number[] => {
		const frag: SqlFragment = parseFilter(filter, fields);
		const rows = db
			.query(`SELECT id FROM items WHERE ${frag.sql}`)
			.all(...frag.params) as { id: number }[];
		return rows.map((r) => r.id).sort((a, b) => a - b);
	};

	/** The fragment must carry ONLY placeholders — never interpolated values. */
	const sqlOf = (filter: string): string => parseFilter(filter, fields).sql;

	test("operators over real rows", () => {
		expect(selectIds("state = READY")).toEqual([1, 4]);
		expect(selectIds("state != READY")).toEqual([2, 3, 5]);
		expect(selectIds("priority < 2")).toEqual([1, 2, 5]);
		expect(selectIds("priority > 1")).toEqual([3, 4]);
		expect(selectIds("priority <= 1")).toEqual([1, 2, 5]);
		expect(selectIds("priority >= 2")).toEqual([3, 4]);
	});

	test("contains maps to LIKE on TEXT", () => {
		expect(selectIds("tags : design")).toEqual([3]);
		expect(selectIds("owner_sid : lane")).toEqual([2, 3, 4, 5]);
	});

	test("AND / OR / NOT with precedence and parens", () => {
		expect(selectIds("state = READY AND priority = 0")).toEqual([1]);
		// OR binds loosest: a OR b AND c parses as a OR (b AND c)
		expect(
			selectIds("state = DONE OR state = CLAIMED AND priority = 1"),
		).toEqual([2, 3]);
		expect(
			selectIds("(state = DONE OR state = CLAIMED) AND priority = 1"),
		).toEqual([2]);
		expect(selectIds("NOT state = READY")).toEqual([2, 3, 5]);
		expect(selectIds("NOT state = READY AND priority = 1")).toEqual([2]);
		expect(selectIds("NOT (state = READY AND priority = 0)")).toEqual([
			2, 3, 4, 5,
		]);
		expect(selectIds("NOT NOT state = DONE")).toEqual([3]);
	});

	test("dot-paths into JSON columns", () => {
		expect(selectIds("payload.kind = work.done")).toEqual([3]);
		expect(selectIds("payload.n >= 3")).toEqual([3, 4]);
		expect(selectIds("payload.kind : claimed")).toEqual([2]);
		// multi-segment path: `$.outer.inner`, not the invalid `$.outer$.inner`
		expect(selectIds("payload.outer.inner = hit")).toEqual([5]);
		expect(sqlOf("payload.outer.inner = hit")).toBe(
			`json_extract(payload, '$.outer.inner') = ?`,
		);
	});

	test("numeric fields bind numbers, not strings", () => {
		const frag = parseFilter("priority = 2", fields);
		expect(frag.params).toEqual([2]);
		expect(typeof frag.params[0]).toBe("number");
	});

	test("quoted values keep spaces and escapes", () => {
		expect(selectIds('state = "READY"')).toEqual([1, 4]);
		expect(selectIds("owner_sid = 'lane-a'")).toEqual([2, 4]);
		// embedded escaped quote stays INSIDE the value, never a delimiter
		const frag = parseFilter("state = 're\\'ady'", fields);
		expect(frag.sql).toBe("state = ?");
		expect(frag.params).toEqual(["re'ady"]);
	});

	test("empty filter is the empty fragment", () => {
		const frag = parseFilter("", fields);
		expect(frag).toEqual({ sql: "", params: [] });
		expect(parseFilter("   \t ", fields).sql).toBe("");
	});

	test("parameterization: hostile values never reach the SQL text", () => {
		const hostile = ["x' OR '1'='1", "'; DROP TABLE items; --", "%_%"];
		for (const v of hostile) {
			const frag = parseFilter(`state = "${v}"`, fields);
			expect(frag.sql).toBe("state = ?");
			expect(frag.params).toEqual([v]);
		}
		// and semantically: the injection attempt matches nothing
		expect(selectIds(`state = "x' OR '1'='1"`)).toEqual([]);
		expect(db.query("SELECT count(*) c FROM items").get().c).toBe(5);
	});

	test("unknown field throws FilterError naming it", () => {
		const bad = ["title = x", "payload.deep.path = 1 AND bogus : y"];
		for (const f of bad) {
			try {
				parseFilter(f, fields);
				expect.unreachable(`expected FilterError for ${f}`);
			} catch (e) {
				expect(e).toBeInstanceOf(FilterError);
				const fe = e as FilterError;
				expect(fe.message).toContain(fe.field ?? "");
				expect(fields[fe.field ?? ""]).toBeUndefined();
			}
		}
	});

	test("dot-path on a non-JSON field is refused", () => {
		expect(() => parseFilter("state.kind = x", fields)).toThrow(FilterError);
		try {
			parseFilter("state.kind = x", fields);
		} catch (e) {
			expect((e as FilterError).field).toBe("state");
		}
	});

	test("malformed filters all fail loud", () => {
		const bad = [
			"state =",
			"= READY",
			"state ~ READY",
			"(state = READY",
			"state = READY)",
			"state = READY AND",
			"AND state = READY",
			"state = 'unterminated",
			"state = READY extra",
			"priority >= abc",
			"state..x = 1",
			".state = 1",
			"- = 1",
			"NOT",
		];
		for (const f of bad) {
			try {
				parseFilter(f, fields);
				expect.unreachable(`expected FilterError for: ${f}`);
			} catch (e) {
				expect(e).toBeInstanceOf(FilterError);
			}
		}
	});

	test("sql shape: parenthesized boolean tree, <> for !=", () => {
		expect(sqlOf("state != DONE OR priority = 1")).toBe(
			"(state <> ? OR priority = ?)",
		);
		expect(sqlOf("payload.kind = work.done")).toBe(
			`json_extract(payload, '$.kind') = ?`,
		);
	});
});

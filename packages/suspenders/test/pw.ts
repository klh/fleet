// test/pw.ts — W2173.5.1 port shim: re-exports the playwright runner
// surface the corpus uses, backfilling `test.each` which the bun-runtime
// loader of @playwright/test 1.64.1 leaves undefined (probed:
// typeof test.each === "function" on node, undefined on bun).
// Supersede this file when W2173.5.3's shared builder lands.
import { expect, test as pwTest } from "@playwright/test";

type EachRow = unknown[];
type EachTable = EachRow[];
type EachCase = (
	title: string,
	fn: (...args: unknown[]) => void | Promise<void>,
) => void;

const t = pwTest as typeof pwTest & { each?: (table: EachTable) => EachCase };
if (typeof t.each !== "function") {
	const fmt = (title: string, row: EachRow): string => {
		let i = 0;
		return title.replace(/%[sdijp%]/g, (c) => {
			if (c === "%%") return "%";
			const v = row[i++];
			if (c === "%j") return JSON.stringify(v);
			if (c === "%i" || c === "%d") return String(Number(v));
			return String(v);
		});
	};
	t.each = (table: EachTable) => (title, fn) => {
		for (const raw of table) {
			const row: EachRow = Array.isArray(raw) ? raw : [raw];
			const shown = /%[sdijp]/.test(title) ? fmt(title, row) : `${title} ${row.join(" ")}`;
			t(shown, () => fn(...row));
		}
	};
}

export { expect, t as test };
// named hook aliases — fixtures take them as values (boardFixture(0, afterAll))
export const afterAll = (fn: () => void | Promise<void>) => t.afterAll(fn);
export const beforeAll = (fn: () => void | Promise<void>) => t.beforeAll(fn);
export const beforeEach = (fn: () => void | Promise<void>) => t.beforeEach(fn);
export const afterEach = (fn: () => void | Promise<void>) => t.afterEach(fn);
export default t;

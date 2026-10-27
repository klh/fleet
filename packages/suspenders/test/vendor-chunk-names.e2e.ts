import { expect, test } from "@playwright/test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeChunks } from "../scripts/build-vendor.ts";

test("byte-identical chunk DAGs produce identical names and imports across checkout paths", () => {
	const dirs = [
		mkdtempSync(join(tmpdir(), "vendor-a-")),
		mkdtempSync(join(tmpdir(), "vendor-b-")),
	];
	try {
		for (const [index, dir] of dirs.entries()) {
			writeFileSync(join(dir, `lit-base${index}.js`), "export const value=1;");
			writeFileSync(
				join(dir, `lit-child${index}.js`),
				`import {value} from "./lit-base${index}.js";export {value};`,
			);
			writeFileSync(
				join(dir, "entry.js"),
				`import {value} from "./lit-child${index}.js";console.log(value);`,
			);
			canonicalizeChunks(dir);
		}
		const snapshot = (dir: string) =>
			readdirSync(dir)
				.sort()
				.map((name) => [name, readFileSync(join(dir, name), "utf8")]);
		expect(snapshot(dirs[0])).toEqual(snapshot(dirs[1]));
		const before = snapshot(dirs[0]);
		canonicalizeChunks(dirs[0]);
		expect(snapshot(dirs[0])).toEqual(before);
	} finally {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	}
});

test("cyclic chunk graphs refuse without deleting original artifacts", () => {
	const dir = mkdtempSync(join(tmpdir(), "vendor-cycle-"));
	try {
		writeFileSync(join(dir, "lit-a.js"), 'import "./lit-b.js";');
		writeFileSync(join(dir, "lit-b.js"), 'import "./lit-a.js";');
		expect(() => canonicalizeChunks(dir)).toThrow("Cyclic vendor chunk");
		expect(readdirSync(dir).sort()).toEqual(["lit-a.js", "lit-b.js"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only AST module specifiers change; ordinary strings, templates, comments and regexes stay exact", () => {
	const dir = mkdtempSync(join(tmpdir(), "vendor-specifiers-"));
	try {
		writeFileSync(join(dir, "lit-a.js"), "export const value=1;");
		const preserved =
			'const text="./lit-a.js";const template=`./lit-a.js`;const regex=/\\.\\/lit-a\\.js/;/* ./lit-a.js */';
		writeFileSync(
			join(dir, "entry.js"),
			`import {value} from "./lit-a.js";export {value} from "./lit-a.js";export * from "./lit-a.js";import("./lit-a.js");${preserved}`,
		);
		canonicalizeChunks(dir);
		const entry = readFileSync(join(dir, "entry.js"), "utf8");
		expect(entry).toContain(preserved);
		const name = readdirSync(dir).find((name) => name.startsWith("lit-"));
		expect(
			entry.match(new RegExp(name?.replaceAll(".", "\\.") ?? "missing", "g")),
		).toHaveLength(4);
		// A non-import self reference must not invent a graph cycle.
		writeFileSync(
			join(dir, "lit-self.js"),
			'export const example="./lit-self.js";',
		);
		expect(() => canonicalizeChunks(dir)).not.toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

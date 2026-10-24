// test/kernel-conf.test.ts — W1253 Amendment A kernel helper law: JSON the
// ONE parser, read-both names, atomic 0600 writes, idempotent yaml migrate.
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	legacyNameOf,
	migrateYamlConf,
	readJsonConfEither,
	writeJsonConf,
} from "../hooks/lib/kernel-conf.ts";

const dir = (): string => {
	const d = join(
		tmpdir(),
		`kernel-conf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(d, { recursive: true });
	return d;
};

const write = (p: string, text: string): void => {
	writeFileSync(p, text);
	chmodSync(p, 0o600);
};

describe("kernel-conf", () => {
	test("readJsonConfEither prefers the .json law name", () => {
		const d = dir();
		write(join(d, "c.json"), JSON.stringify({ a: 1 }));
		write(join(d, "c.yaml"), JSON.stringify({ a: 2 }));
		expect(readJsonConfEither(join(d, "c.json"))).toEqual({ a: 1 });
		rmSync(join(d, "c.json"));
		expect(readJsonConfEither(join(d, "c.json"))).toEqual({ a: 2 });
	});
	test("rejects yaml content — the ONE parser law has no yaml leg", () => {
		const d = dir();
		write(join(d, "c.yaml"), "a: 1\n");
		expect(() => readJsonConfEither(join(d, "c.json"))).toThrow();
	});
	test("writeJsonConf is atomic 0600 and leaves no tmp files", () => {
		const d = dir();
		const p = join(d, "nested", "c.json");
		writeJsonConf(p, { x: "y" });
		expect(readFileSync(p, "utf8")).toBe('{\n\t"x": "y"\n}\n');
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(d, "nested"))).toEqual(["c.json"]);
	});

	test("migrateYamlConf: once with .bak, idempotent, mode-600 gate", () => {
		const d = dir();
		const y = join(d, "conf.yaml");
		const j = join(d, "conf.json");
		// neither on disk
		expect(migrateYamlConf(y, j)).toBe("absent");
		write(y, "a: 1\nlist:\n  - x\n  - y\n");
		expect(migrateYamlConf(y, j)).toBe("migrated");
		expect(JSON.parse(readFileSync(j, "utf8"))).toEqual({
			a: 1,
			list: ["x", "y"],
		});
		expect(readFileSync(`${y}.bak`, "utf8")).toBe(
			"a: 1\nlist:\n  - x\n  - y\n",
		);
		expect(() => readFileSync(y)).toThrow();
		// second call is a no-op ("kept")
		expect(migrateYamlConf(y, j)).toBe("kept");
	});
	test("legacyNameOf maps the law name to its yaml twin", () => {
		expect(legacyNameOf("/x/stack.json")).toBe("/x/stack.yaml");
	});
});

// test/prefer-set.test.ts — W1354: the `prefer` CLI core (hooks/lib/
// prefer-set.ts) — the gate-exempt repo .prefer hub-pin write path.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	PREFER_SET_KEYS,
	preferSetTarget,
	readPreferSet,
	setPreferValue,
	validatePreferSet,
} from "../hooks/lib/prefer-set.ts";

const dir = mkdtempSync(join(tmpdir(), "prefer-set-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.describe("validatePreferSet", () => {
	test("accepts a hub label", () => {
		expect(validatePreferSet("hub", "nas")).toBeNull();
		expect(validatePreferSet("hub", "e2e-hub")).toBeNull();
	});
	test("rejects a bad hub label", () => {
		expect(validatePreferSet("hub", "na s")).toContain("registry label");
		expect(validatePreferSet("hub", "")).toContain("registry label");
	});
	test("accepts a hub-url candidate list", () => {
		expect(
			validatePreferSet("hub-url", "https://a.local:4101,http://b.local:4101"),
		).toBeNull();
	});
	test("rejects non-http hub-url", () => {
		expect(validatePreferSet("hub-url", "ftp://x")).toContain("http(s) URLs");
	});
	test("restricts the key vocabulary (quoted prefer is soft, hub= pins)", () => {
		expect(validatePreferSet("prefer", "glm")).toContain("hub | hub-url");
		expect(validatePreferSet("tag", "ikea")).toContain("hub | hub-url");
	});
});

test.describe("setPreferValue", () => {
	test("creates a missing .prefer with a provenance header", () => {
		const file = join(dir, "fresh.prefer");
		const r = setPreferValue(file, "hub", "desktop");
		expect(r.action).toBe("created");
		const text = readFileSync(file, "utf8");
		expect(text).toContain("# .prefer");
		expect(text).toContain("hub=desktop\n");
	});
	test("appends to an existing file", () => {
		const file = join(dir, "grow.prefer");
		writeFileSync(file, "# mine\nprefer=\"ikea llms\"\n");
		const r = setPreferValue(file, "hub", "nas");
		expect(r.action).toBe("appended");
		const text = readFileSync(file, "utf8");
		expect(text).toContain('prefer="ikea llms"');
		expect(text.endsWith("hub=nas\n")).toBe(true);
	});
	test("replaces the existing key line in place (position law)", () => {
		const file = join(dir, "swap.prefer");
		writeFileSync(file, "# c\nhub=old\nhub-url=https://keep.local:4101\n");
		const r = setPreferValue(file, "hub", "new");
		expect(r.action).toBe("replaced");
		const text = readFileSync(file, "utf8");
		expect(text).toContain("hub=new");
		expect(text).not.toContain("hub=old");
		// the comment line survives; hub-url untouched
		expect(text).toContain("# c");
		expect(text).toContain("hub-url=https://keep.local:4101");
	});
	test("a commented hub= line is not replaced", () => {
		const file = join(dir, "comment.prefer");
		writeFileSync(file, "# hub=example\n");
		const r = setPreferValue(file, "hub", "real");
		expect(r.action).toBe("appended");
		expect(readFileSync(file, "utf8")).toContain("# hub=example");
	});
});

test.describe("readPreferSet + preferSetTarget", () => {
	test("reads back the first uncommented pin per key", () => {
		const file = join(dir, "read.prefer");
		writeFileSync(file, "hub=a\nhub-url=https://x.local:4101\nhub=b\n");
		const pins = readPreferSet(file);
		expect(pins.hub?.value).toBe("a");
		expect(pins["hub-url"]?.value).toBe("https://x.local:4101");
	});
	test("target resolution lands on the git toplevel .prefer", () => {
		const top = Bun.spawnSync(
			["git", "-C", import.meta.dir, "rev-parse", "--show-toplevel"],
			{ stdout: "pipe" },
		)
			.stdout.toString()
			.trim();
		expect(preferSetTarget(import.meta.dir)).toBe(join(top, ".prefer"));
	});
	test("key vocabulary is exactly the exec-chain hub pair", () => {
		expect([...PREFER_SET_KEYS]).toEqual(["hub", "hub-url"]);
	});
});

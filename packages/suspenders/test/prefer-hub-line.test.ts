// test/prefer-hub-line.test.ts — W1352: unquoted executor-chain hub= line
// written by installer/hub setup when a hub is configured or a quoted
// prefer names one (quoted prefer is routing-plane only — W519).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensurePreferHubLine,
	gitToplevel,
	hasPreferHubLine,
	hubLabelFromQuotedPrefer,
	resolvePreferHubLabel,
} from "../scripts/lib/prefer-hub-line.ts";

const dirs: string[] = [];
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), "w1352-prefer-hub-"));
	dirs.push(d);
	return d;
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("prefer-hub-line", () => {
	test("quoted prefer naming a known hub label is recognized", () => {
		const text = [
			"# comment",
			'tag = "fleet"',
			'prefer = "ikea llms"',
			'prefer = "nas gateway"',
		].join("\n");
		expect(hubLabelFromQuotedPrefer(text, ["nas", "desktop"])).toBe("nas");
		expect(hubLabelFromQuotedPrefer(text, ["desktop"])).toBeNull();
		expect(hubLabelFromQuotedPrefer("", ["nas"])).toBeNull();
	});

	test("unquoted single-token prefer stays executor-plane (never a hub hint)", () => {
		const text = "prefer=glm-flash2\nmust=opus\n";
		expect(hubLabelFromQuotedPrefer(text, ["nas"])).toBeNull();
	});

	test("comma-list quoted prefer matches any token", () => {
		const text = 'prefer = "glm-flash2, desktop"';
		expect(hubLabelFromQuotedPrefer(text, ["desktop"])).toBe("desktop");
	});

	test("hasPreferHubLine: only an unquoted single-token hub= counts", () => {
		expect(hasPreferHubLine("hub=nas\n")).toBe(true);
		expect(hasPreferHubLine("# hub=nas\n")).toBe(false);
		expect(hasPreferHubLine('hub: "nas"\n')).toBe(false);
		expect(hasPreferHubLine("hub= nas\n")).toBe(true); // trimmed single token
		expect(hasPreferHubLine("prefer=nas\n")).toBe(false);
	});

	test("ensurePreferHubLine appends idempotently, never clobbers", () => {
		const repo = scratch();
		writeFileSync(join(repo, ".prefer"), 'prefer = "nas"\nmust=opus\n');
		const first = ensurePreferHubLine(repo, "nas");
		expect(first.action).toBe("written");
		const text = readFileSync(join(repo, ".prefer"), "utf8");
		expect(text).toContain('prefer = "nas"');
		expect(text).toContain("must=opus");
		expect(text).toContain("hub=nas");
		const second = ensurePreferHubLine(repo, "nas");
		expect(second.action).toBe("present");
		expect(readFileSync(join(repo, ".prefer"), "utf8")).toBe(text);
	});

	test("ensurePreferHubLine creates .prefer when absent", () => {
		const repo = scratch();
		const r = ensurePreferHubLine(repo, "desktop");
		expect(r.action).toBe("created");
		expect(readFileSync(join(repo, ".prefer"), "utf8")).toContain(
			"hub=desktop",
		);
	});

	test("resolvePreferHubLabel: quoted naming wins over sole hub; ambiguous multi-hub without a named label stays null", () => {
		expect(resolvePreferHubLabel('prefer = "x, nas"', ["nas", "desk"])).toBe(
			"nas",
		);
		expect(resolvePreferHubLabel("must=opus", ["nas"])).toBe("nas");
		expect(resolvePreferHubLabel(null, ["nas"])).toBe("nas");
		expect(resolvePreferHubLabel("must=opus", ["nas", "desk"])).toBeNull();
		// W1352 mission: a configured (sole) hub pins even when the quoted
		// prefer names something else — hub= is the safe chain line
		expect(resolvePreferHubLabel('prefer = "ikea"', ["nas"])).toBe("nas");
	});

	test("gitToplevel resolves a repo tree (null outside a repo)", () => {
		expect(gitToplevel(import.meta.dir)).not.toBeNull();
		expect(gitToplevel("/")).toBeNull();
	});
});

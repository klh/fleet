// scripts/lib/prefer-routing.test.ts — W519: .prefer prefer= soft routing,
// must= reserved. Covers the grammar (quoted/unquoted, comments, loud
// non-fatal errors), walk-up resolution (nearest wins per key, tree-level
// across repo boundaries), and the brief-composer notes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseRoutingPrefer,
	preferRoutingBriefLines,
	resolveRoutingPrefer,
} from "./prefer-routing.ts";

const scratch = (): string =>
	mkdtempSync(join(tmpdir(), "w519-prefer-routing-"));

describe("parseRoutingPrefer (grammar)", () => {
	test("quoted value with trailing comment; unquoted tolerated", () => {
		const a = parseRoutingPrefer(
			"/x/.prefer",
			'# c\nprefer = "ikea llms" # IKEA blue above\n',
		);
		expect(a.prefer).toBe("ikea llms");
		expect(a.errors).toEqual([]);
		const b = parseRoutingPrefer("/x/.prefer", "prefer=local distill\n");
		expect(b.prefer).toBe("local distill");
		// plane split: unquoted single token = executor plane, not ours
		const c = parseRoutingPrefer("/x/.prefer", "prefer=opus\n");
		expect(c.prefer).toBe(null);
		expect(c.errors).toEqual([]);
		// quoted single token IS routing (the schema quotes everything)
		const d = parseRoutingPrefer("/x/.prefer", 'prefer = "opus"\n');
		expect(d.prefer).toBe("opus");
	});

	test("tag/color are foreign planes — silent; unknown keys loud", () => {
		const r = parseRoutingPrefer(
			"/x/.prefer",
			'tag = "ikea"\ncolor = "#0058A3"\nmode = "yolo"\n',
		);
		expect(r.prefer).toBe(null);
		expect(r.must).toBe(null);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("/x/.prefer:3");
		expect(r.errors[0]).toContain("unknown key");
	});

	test("invalid routing expr is loud and unresolved — no silent guess", () => {
		// two locations = W96 grammar error; empty value = needs-a-value error
		const r = parseRoutingPrefer(
			"/x/.prefer",
			'prefer = "local cloud"\nmust = ""\n',
		);
		expect(r.prefer).toBe(null);
		expect(r.errors[0]).toContain("prefer=: duplicate location");
		expect(r.errors[1]).toContain('must= needs a "value"');
	});

	test("first valid definition wins; duplicate is a loud non-fatal error", () => {
		const r = parseRoutingPrefer(
			"/x/.prefer",
			'prefer = "first one"\nprefer = "second one"\n',
		);
		expect(r.prefer).toBe("first one");
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("set more than once");
	});
});

describe("resolveRoutingPrefer (walk-up)", () => {
	test("nearest definition wins per key, across a repo boundary", () => {
		const root = scratch();
		const repo = join(root, "icomdev", "somerepo");
		mkdirSync(join(repo, "sub"), { recursive: true });
		writeFileSync(
			join(root, "icomdev", ".prefer"),
			'prefer = "ikea llms"\ncolor = "#0058A3"\n',
		);
		// the repo overrides only prefer — must inherits from the tree file
		writeFileSync(join(repo, ".prefer"), 'prefer = "local reasoning"\n');
		try {
			const r = resolveRoutingPrefer(repo);
			expect(r.prefer).toBe("local reasoning");
			expect(r.preferSource).toBe(join(repo, ".prefer"));
			expect(r.must).toBe(null);
			const sub = resolveRoutingPrefer(join(repo, "sub"));
			expect(sub.prefer).toBe("local reasoning");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("preferRoutingBriefLines (brief composer notes)", () => {
	test("prefer= notes SOFT semantics; must= notes RESERVED", () => {
		const lines = preferRoutingBriefLines({
			prefer: "ikea llms",
			must: "local",
			preferSource: null,
			mustSource: null,
			errors: [],
		});
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('prefer="ikea llms"');
		expect(lines[0]).toContain("SOFT");
		expect(lines[0]).toContain("never blocks");
		expect(lines[1]).toContain('must="local"');
		expect(lines[1]).toContain("RESERVED");
		expect(lines[1]).toContain("NOT enforced");
	});

	test("empty routing = no lines", () => {
		expect(
			preferRoutingBriefLines({
				prefer: null,
				must: null,
				preferSource: null,
				mustSource: null,
				errors: [],
			}),
		).toEqual([]);
	});
});

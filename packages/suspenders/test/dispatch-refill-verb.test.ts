// test/dispatch-refill-verb.test.ts — W1255.6 verb-kit finish: the dispatch
// CLI's refill face declares through the kit (scripts/lib/refill-verb.ts) and
// dispatch-next.ts parses its argv through parseVerb (the hand-rolled indexOf
// shim retired). Pins the spec vocabulary, the parse semantics dispatch-next
// relies on, and the registry help door (exit 0, "Usage: dispatch" present).
import { describe, expect, test } from "bun:test";
import { refillVerb } from "../scripts/lib/refill-verb.ts";
import { parseVerb, renderRegistryHelp } from "../hooks/lib/verb-kit.ts";

describe("refillVerb — the kit-declared dispatch face (W1255.6)", () => {
	test("carries the flag vocabulary dispatch-next consumes", () => {
		expect(refillVerb.name).toBe("refill");
		expect(refillVerb.lax).toBe(true);
		expect(refillVerb.flags).toEqual([
			"--repo",
			"--target",
			"--item",
			"--route",
			"--show-capsule",
			"--resume-from",
			"--role",
		]);
		expect(refillVerb.switches).toEqual([
			"--dry-run",
			"--no-belt",
			"--allow-ungoverned",
		]);
	});

	test("value flags consume the next token; first occurrence wins", () => {
		const r = parseVerb(refillVerb, [
			"--item",
			"W1",
			"--item",
			"W2",
			"--target",
			"3",
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.parsed.flag("--item")).toBe("W1");
			expect(r.parsed.flag("--target")).toBe("3");
		}
	});

	test("switches consume no value; lax swallows unknown flags", () => {
		const r = parseVerb(refillVerb, [
			"--dry-run",
			"--target",
			"6",
			"--mystery",
			"x",
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.parsed.flag("--target")).toBe("6");
			expect(r.parsed.flag("--mystery")).toBeNull();
			expect(r.parsed.pos).toEqual(["x"]);
		}
	});

	test("--flag=value parses (the shape the indexOf shim missed)", () => {
		const r = parseVerb(refillVerb, ["--item=W99", "--dry-run"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.parsed.flag("--item")).toBe("W99");
			expect(r.parsed.flag("--dry-run")).toBe("true");
		}
	});
});

describe("dispatch registry help — kit-rendered (W1255.6)", () => {
	test("about line keeps the Usage: dispatch anchor and lists all three faces", () => {
		const help = renderRegistryHelp(
			"dispatch",
			"Usage: dispatch [options]",
			[refillVerb, { name: "registry" }, { name: "intent" }],
			"Crash recovery defaults to three total launches per lane.",
		);
		expect(
			help.startsWith("Usage: dispatch [options] refill | registry | intent"),
		).toBe(true);
		expect(help).toContain(
			"Crash recovery defaults to three total launches per lane.",
		);
	});
});

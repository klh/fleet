// test/repo-laws.test.ts — W164 belt: the resolution chain (dotfile > user
// > central > default), must-no-fit honest errors, and the user plane.
// Pure tests — temp files only (BUCKLE_SECRETS_HOME pinned), no network
// (candidates here are literal fixtures, not probed endpoints).
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyLawStack,
	composeLawPlan,
	lawExprToHint,
	parseLlmDotfile,
	resolveLawStack,
	type LawStack,
} from "../bin/repo-laws.ts";
import { hintFit, hintTotal, parseHint } from "../bin/route-policy.ts";

const TMP = mkdtempSync(join(tmpdir(), "w164-belt-"));
const ENV = { ...process.env, BUCKLE_SECRETS_HOME: join(TMP, "secrets") };
const CAND = (
	kind: string,
	machine: string,
	model: string,
	tags: string,
	healthy = true,
) => ({ kind, machine, model, tags, healthy });

test.describe("dotfile parse (belt port)", () => {
	test("musts AND, first prefer wins, invalid lines loud @unit", () => {
		const p = parseLlmDotfile("prefer=model:qwen*\nmust=cloud\nprefer=local\n");
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(p.musts).toHaveLength(1);
		expect(p.prefer).not.toBeNull();
		expect(p.tier).toBeNull();
	});

	test("invalid line keeps its number @unit", () => {
		const p = parseLlmDotfile("# c\nwrongo=1\n");
		expect(p.ok).toBe(false);
		if (p.ok) return;
		expect(p.errors).toEqual([
			{
				line: 2,
				why: "unknown law key 'wrongo' — expected prefer=, must=, tier=, fallback=",
			},
		]);
	});
});

test.describe("resolution order (dotfile > user > central > default)", () => {
	// two candidates: a local qwen and a cloud glm — the pool ordering tells
	// the layers apart
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	const hintOf = (verb: "prefer" | "must", expr: string) => {
		const h = lawExprToHint(verb, expr);
		if (!h.ok) throw new Error(h.why);
		return h.hint;
	};
	const stackOf = (over: Partial<LawStack>): LawStack => ({
		repo: "/r",
		dotfile: null,
		user: null,
		central: [],
		company: false,
		layers: [],
		prefer: { prefer: null, must: null, source: null, errors: [] },
		...over,
	});

	test("dotfile prefer beats user prefer beats central prefer @unit", () => {
		const stack = stackOf({
			dotfile: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			layers: ["dotfile"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // local first
	});

	test("user prefer applies when the dotfile is absent @unit", () => {
		const stack = stackOf({
			user: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			layers: ["user"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box");
	});

	test("dotfile prefer OVERRIDES user prefer (repo wins) @unit", () => {
		const stack = stackOf({
			dotfile: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "cloud"),
				tier: null,
				fallback: null,
			},
			user: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			layers: ["dotfile", "user"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("hub"); // the dotfile's cloud wins
	});

	test("no laws → belt's own default ordering @unit", () => {
		const plan = composeLawPlan(stackOf({ layers: [] }), null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // belt default: locals first
	});

	test("central must beats user prefer (entitlement ceilings) — honestly @unit", () => {
		const stack = stackOf({
			user: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			central: [{ id: "repos.corp", laws: ["must=cloud"] }],
			company: true,
			layers: ["user", "central"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// the cloud glm survives the central must; the local qwen is filtered
		expect(r.candidates.map((c) => c.machine)).toEqual(["hub"]);
	});

	test("must-no-fit errors honestly, NAMING the layer @unit", () => {
		const stack = stackOf({
			central: [{ id: "repos.corp", laws: ["must=model:secret-model"] }],
			company: true,
			layers: ["central"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.layer).toBe("central:repos.corp");
		expect(r.why).toContain("no healthy full fit");
		expect(r.why).toContain("must never substitutes");
	});

	test("request-hint prefer outranks the dotfile prefer @unit", () => {
		const stack = stackOf({
			dotfile: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "cloud"),
				tier: null,
				fallback: null,
			},
			layers: ["dotfile"],
		});
		const req = parseHint("prefer local");
		expect(req.ok).toBe(true);
		if (!req.ok) return;
		const plan = composeLawPlan(stack, req.hint);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // the request wins
	});
});

test.describe("resolveLawStack (file-backed)", () => {
	test("dotfile + user config + central last-known all read @unit", () => {
		const repo = mkdtempSync(join(tmpdir(), "w164-brepro-"));
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, ".llm"), "prefer=local\n");
		const home = join(TMP, "stack-home");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "repo-laws.json"),
			JSON.stringify({
				repos: {
					[repo]: {
						name: "r",
						dotfile: "prefer=cloud\n",
						source: "dotfile",
						updated_at: "",
					},
				},
			}),
		);
		writeFileSync(
			join(home, "federation-last-known.json"),
			JSON.stringify({
				manifest: {
					rules: [
						{
							id: "repos.corp",
							kind: "repo-law",
							target: repo,
							laws: ["must=cloud"],
						},
					],
				},
			}),
		);
		const s = resolveLawStack(repo, { ...ENV, BUCKLE_SECRETS_HOME: home });
		expect(s.dotfile).not.toBeNull();
		expect(s.user).not.toBeNull();
		expect(s.company).toBe(true);
		expect(s.layers).toEqual(["dotfile", "user", "central"]);
	});

	test("private repo: no matching central rule → company false (hub not consulted) @unit", () => {
		const repo = mkdtempSync(join(tmpdir(), "w164-brepprivate-"));
		mkdirSync(repo, { recursive: true });
		const s = resolveLawStack(repo, ENV);
		expect(s.company).toBe(false);
		expect(s.central).toEqual([]);
	});
});

// W598: the .prefer tree layer — quoted prefer=/must= fold in outermost
test.describe("W598 .prefer ranking", () => {
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	test("quoted prefer above the repo ranks EVERY repo-scoped call @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-tree-"));
		const repo = join(tree, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(tree, ".prefer"), 'prefer = "cloud"\n');
		const s = resolveLawStack(repo, ENV);
		expect(s.prefer.prefer).not.toBeNull();
		expect(s.prefer.source).toBe(join(tree, ".prefer"));
		expect(s.layers).toEqual([".prefer"]);
		const r = applyLawStack(pool, composeLawPlan(s, null), hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("hub"); // cloud ranks first
		expect(r.why).toContain(".prefer:prefer(cloud)");
	});
});

// W598: .prefer plane split — the executor chain keeps unquoted single tokens
test.describe("W598 .prefer plane split", () => {
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	test("unquoted single tokens stay the executor plane (never routing) @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-exec-"));
		writeFileSync(join(tree, ".prefer"), "must=opus\nprefer=glm-5.3\n");
		const s = resolveLawStack(tree, ENV);
		expect(s.prefer.prefer).toBeNull();
		expect(s.prefer.must).toBeNull();
		expect(s.layers).toEqual([]);
	});

	test("must= from .prefer is reserved — validated, surfaced, never a filter @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-must-"));
		const repo = join(tree, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(tree, ".prefer"), 'must = "cloud"\n');
		const s = resolveLawStack(repo, ENV);
		expect(s.prefer.must).not.toBeNull();
		expect(s.layers).toEqual([".prefer"]);
		const plan = composeLawPlan(s, null);
		expect(plan.musts).toHaveLength(0);
		expect(plan.why).toContain("reserved");
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates).toHaveLength(2);
	});
});

// W598: .prefer resolution order — nearest definition wins per key
test.describe("W598 .prefer resolution order", () => {
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	test("walk crosses repo boundaries; nearest definition wins per key @unit", () => {
		const outer = mkdtempSync(join(tmpdir(), "w598-outer-"));
		const mid = join(outer, "mid");
		const repo = join(mid, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(outer, ".prefer"), 'prefer = "cloud"\nmust = "local"\n');
		writeFileSync(join(mid, ".prefer"), 'prefer = "local"\n');
		const s = resolveLawStack(repo, ENV);
		expect(s.prefer.prefer).not.toBeNull();
		const r = applyLawStack(pool, composeLawPlan(s, null), hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // mid's nearest local wins
	});
});

// W598: the request hint keeps W96 nearness over the tree .prefer
test.describe("W598 .prefer vs request hint", () => {
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	test("request hint outranks the tree .prefer @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-req-"));
		const repo = join(tree, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(tree, ".prefer"), 'prefer = "cloud"\n');
		const s = resolveLawStack(repo, ENV);
		const req = parseHint("prefer local");
		expect(req.ok).toBe(true);
		if (!req.ok) return;
		const r = applyLawStack(
			pool,
			composeLawPlan(s, req.hint),
			hintFit,
			hintTotal,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box");
	});
});

// W598: .prefer loud, non-fatal errors — the stack never blanks on junk
test.describe("W598 .prefer loud errors", () => {
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	test("first prefer wins; later duplicates are loud @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-dup-"));
		writeFileSync(
			join(tree, ".prefer"),
			'prefer = "cloud"\nprefer = "local"\n',
		);
		const s = resolveLawStack(tree, ENV);
		expect(s.prefer.errors.join(" ")).toContain("set more than once");
		const r = applyLawStack(pool, composeLawPlan(s, null), hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("hub"); // first (cloud) ranks
	});

	test("unknown keys are loud but non-fatal @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-keys-"));
		writeFileSync(
			join(tree, ".prefer"),
			'tag = "w517"\ncolor = "#ff0000"\nnope = "x y"\n',
		);
		const s = resolveLawStack(tree, ENV);
		expect(s.prefer.prefer).toBeNull();
		expect(s.prefer.errors).toHaveLength(1); // tag/color silent, nope loud
		expect(s.prefer.errors[0]).toContain("unknown key");
	});

	test("invalid routing expr is loud and never resolves @unit", () => {
		const tree = mkdtempSync(join(tmpdir(), "w598-bad-"));
		writeFileSync(join(tree, ".prefer"), 'prefer = "model:"\n');
		const s = resolveLawStack(tree, ENV);
		expect(s.prefer.prefer).toBeNull();
		expect(s.prefer.errors[0]).toContain("model: needs an id or glob");
	});
});

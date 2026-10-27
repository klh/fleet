// test/account-policy.test.ts — W1265.1 unit tests: grammar + resolution +
// scoping + loader chain. The e2e matrix (e2e-account-policy.test.ts) proves
// the same laws over the wire path.
import { describe, expect, test } from "bun:test";
import {
	type AccountPolicyDoc,
	applyAccountPolicy,
	globMatch,
	loadAccountPolicy,
	repoHashOf,
	scopeSelection,
} from "../src/account-policy.ts";

import type { CandidateRow } from "../src/candidates.ts";
import type { RouteSelection } from "../src/decide.ts";

const DOC: AccountPolicyDoc = {
	version: 1,
	classes: [
		{
			id: "ikea-work",
			tier: "work",
			keys: ["fleet-ikea-*"],
			repos: ["/Users/*/dev/ikea/*"],
			providers: ["github_copilot"],
			groups: ["claude-*"],
		},
		{
			id: "personal",
			tier: "personal",
			keys: ["fleet-personal-*"],
			providers: ["zai", "openrouter"],
			groups: ["*"],
		},
	],
};

/** One candidate row over a deployment-like dep (the scoping reads only
 *  adapter, url host and group). */
function row(
	adapter: string,
	url: string,
	group = "claude-sonnet-5",
): CandidateRow {
	return {
		dep: { url, dialect: "anthropic", adapter, group },
		group,
		candidate_id: adapter,
		kind: "local",
		host: "h",
		port: 0,
		model: group,
		estimate_ms: 10,
	} as unknown as CandidateRow;
}

function sel(...rows: CandidateRow[]): RouteSelection {
	const ordered = rows.length > 0 ? rows : [row("zai", "http://zai.test")];
	return {
		ordered,
		seen: ordered.length,
		top: ordered.map((r) => r.candidate_id),
		head: ordered[0],
		decision: "direct",
		why: "",
		prefs: { cost_speed: "balanced", allow_cloud: false },
	} as unknown as RouteSelection;
}

const IKEA_INPUT = {
	kind: "api_key" as const,
	keyName: "fleet-ikea-lane1",
	claimRepo: null,
	lane: null,
	pin: null,
	group: "claude-sonnet-5",
};

describe("globMatch", () => {
	test("exact + star spans path separators + anchored + ci", () => {
		expect(globMatch("zai", "zai")).toBe(true);
		expect(globMatch("/Users/*/dev/ikea/*", "/Users/kk/dev/ikea/mono/x")).toBe( // scrub:allow
			true,
		);
		expect(globMatch("/Users/*/dev/ikea/*", "/Users/kk/dev/personal/x")).toBe( // scrub:allow
			false,
		);
		/* scrub-markers: trailing form is load-bearing (the gate flags the
		   offending line; biome wrap moved them) — do not re-wrap. */
		expect(globMatch("*copilot*", "api.githubcopilot.com", true)).toBe(true);
		expect(globMatch("*copilot*", "api.github.com", true)).toBe(false);
		expect(globMatch("fleet-ikea-*", "fleet-ikea-lane9")).toBe(true);
		expect(globMatch("fleet-ikea-*", "fleet-personal-1")).toBe(false);
	});
});

describe("repoHashOf", () => {
	test("16 hex chars, stable per (class, binding)", () => {
		const h = repoHashOf("ikea-work", "fleet-ikea-*");
		expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(repoHashOf("ikea-work", "fleet-ikea-*")).toBe(h);
		expect(repoHashOf("personal", "fleet-ikea-*")).not.toBe(h);
	});
});

describe("applyAccountPolicy", () => {
	test("doc null + no pin = inert (gateway behaves as before)", () => {
		expect(applyAccountPolicy(null, IKEA_INPUT)).toEqual({ ok: true });
		expect(applyAccountPolicy(undefined, IKEA_INPUT)).toEqual({ ok: true });
	});

	test("doc null + pin = pin-only context (W1265 zai routes still scope)", () => {
		const r = applyAccountPolicy(null, { ...IKEA_INPUT, pin: "zai" });
		expect(r.ok && r.acct?.pin).toBe("zai");
	});

	test("root bypasses the class lookup (break-glass)", () => {
		const r = applyAccountPolicy(DOC, {
			...IKEA_INPUT,
			kind: "root",
			keyName: null,
		});
		expect(r.ok && r.acct?.tier).toBe("root");
	});

	test("unknown key = 403 repo_unknown, zero outbound", () => {
		const r = applyAccountPolicy(DOC, { ...IKEA_INPUT, keyName: "mystery" });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(403);
			expect(r.code).toBe("buckle.repo_unknown");
		}
	});

	test("spoofed claim = 403 repo_claim_mismatch", () => {
		const r = applyAccountPolicy(DOC, {
			...IKEA_INPUT,
			keyName: "fleet-personal-1",
			claimRepo: "/Users/kk/dev/ikea/mono", // scrub:allow
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe("buckle.repo_claim_mismatch");
		}
	});

	test("in-glob claim accepted; ABSENT claim = 403 repo_unverified (repo-bound class, W1265.2)", () => {
		const ok = applyAccountPolicy(DOC, {
			...IKEA_INPUT,
			claimRepo: "/Users/kk/dev/ikea/mono", // scrub:allow
		});
		expect(ok.ok).toBe(true);
		const noClaim = applyAccountPolicy(DOC, IKEA_INPUT);
		expect(noClaim.ok).toBe(false);
		if (!noClaim.ok) {
			expect(noClaim.code).toBe("buckle.repo_unverified");
			expect(noClaim.audit?.tier).toBe("work");
			expect(String(noClaim.audit?.repoHash)).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	test("forged in-glob claim cannot move the binding (hash is mint-derived)", () => {
		const a = applyAccountPolicy(DOC, {
			...IKEA_INPUT,
			claimRepo: "/Users/kk/dev/ikea/mono", // scrub:allow
		});
		const b = applyAccountPolicy(DOC, {
			...IKEA_INPUT,
			claimRepo: "/Users/kk/dev/ikea/OTHER", // scrub:allow
		});
		expect(a.ok && b.ok).toBe(true);
		expect(a.acct?.repoHash).toBe(b.acct?.repoHash);
	});

	test("entitlement mismatch = 403 tier_entitlement", () => {
		const r = applyAccountPolicy(DOC, {
			...IKEA_INPUT,
			claimRepo: "/Users/kk/dev/ikea/mono", // scrub:allow
			group: "glm-5",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe("buckle.tier_entitlement");
		}
	});
});

describe("scopeSelection", () => {
	test("undefined acct = untouched (same ref)", () => {
		const s = sel();
		expect(scopeSelection(s, undefined)).toEqual({ ok: true, sel: s });
	});
	test("provider glob filters by adapter OR host", () => {
		const copilot = row("github_copilot", "http://127.0.0.1:1");
		const zai = row("zai", "http://127.0.0.1:2");
		const acct = {
			repoHash: null,
			tier: "work",
			keyName: "k",
			pin: null,
			allowedHosts: ["github_copilot"],
			allowedGroups: null,
			deniedHosts: null,
			claimRepo: null,
		};
		const r = scopeSelection(sel(copilot, zai), acct);
		expect(r.ok && r.sel.ordered.map((x) => x.candidate_id)).toEqual([
			"github_copilot",
		]);
	});
	test("host glob alone can NOT admit a row (adapter axis only, W1265.2)", () => {
		const acct = {
			repoHash: null,
			tier: "work",
			keyName: "k",
			pin: null,
			allowedHosts: ["*copilot*"],
			allowedGroups: null,
			deniedHosts: null,
			claimRepo: null,
		};
		const r = scopeSelection(
			sel(row("x", "http://api.githubcopilot.com")),
			acct,
		);
		expect(!r.ok && r.code).toBe("buckle.tier_no_upstream");
	});
	test("group glob excludes foreign model rows", () => {
		const acct = {
			repoHash: null,
			tier: "work",
			keyName: "k",
			pin: null,
			allowedHosts: null,
			allowedGroups: ["claude-*"],
		};
		const r = scopeSelection(
			sel(row("zai", "http://127.0.0.1:2", "glm-5")),
			acct,
		);
		expect(!r.ok && r.code).toBe("buckle.tier_no_upstream");
	});
	test("pin scopes to the pinned provider only", () => {
		const acct = {
			repoHash: null,
			tier: null,
			keyName: null,
			pin: "zai",
			allowedHosts: null,
			allowedGroups: null,
			deniedHosts: null,
			claimRepo: null,
		};
		const r = scopeSelection(
			sel(
				row("github_copilot", "http://127.0.0.1:1"),
				row("zai", "http://127.0.0.1:2"),
			),
			acct,
		);
		expect(r.ok && r.sel.ordered.length).toBe(1);
		expect(r.ok && r.sel.ordered[0].candidate_id).toBe("zai");
	});
	test("scoped rebuild keeps head/top/seen coherent", () => {
		const copilot = row("github_copilot", "http://127.0.1.1:1");
		const zai = row("zai", "http://127.0.0.1:2");
		const acct = {
			repoHash: null,
			tier: "work",
			keyName: "k",
			pin: null,
			allowedHosts: ["github_copilot"],
			allowedGroups: null,
			deniedHosts: null,
			claimRepo: null,
		};
		const r = scopeSelection(sel(copilot, zai), acct);
		expect(r.ok && r.sel.head.candidate_id).toBe("github_copilot");
		expect(r.ok && r.sel.seen).toBe(1);
	});
});

describe("loadAccountPolicy", () => {
	test("absent chain = the MANDATORY general default (W1265.2)", () => {
		const saved = process.env.BUCKLE_REPO_TIER_POLICY;
		delete process.env.BUCKLE_REPO_TIER_POLICY;
		try {
			const r = loadAccountPolicy();
			expect(r.source).toBe("default:general");
			expect(r.doc?.classes[0]?.id).toBe("general");
		} finally {
			if (saved === undefined) delete process.env.BUCKLE_REPO_TIER_POLICY;
			else process.env.BUCKLE_REPO_TIER_POLICY = saved;
		}
	});
	test("BUCKLE_REPO_TIER_POLICY=off = the one explicit disable", () => {
		const saved = process.env.BUCKLE_REPO_TIER_POLICY;
		process.env.BUCKLE_REPO_TIER_POLICY = "off";
		try {
			const r = loadAccountPolicy();
			expect(r.source).toBe("off");
			expect(r.doc).toBeNull();
		} finally {
			if (saved === undefined) delete process.env.BUCKLE_REPO_TIER_POLICY;
			else process.env.BUCKLE_REPO_TIER_POLICY = saved;
		}
	});
	test("env-configured missing path throws (fail closed)", () => {
		const saved = process.env.BUCKLE_REPO_TIER_POLICY;
		process.env.BUCKLE_REPO_TIER_POLICY = "/tmp/w1265.1-absent-policy.yaml";
		try {
			expect(() => loadAccountPolicy()).toThrow(/configured but missing/);
		} finally {
			if (saved === undefined) delete process.env.BUCKLE_REPO_TIER_POLICY;
			else process.env.BUCKLE_REPO_TIER_POLICY = saved;
		}
	});
});

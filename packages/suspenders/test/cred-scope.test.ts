// test/cred-scope.test.ts — W1211 credential-scoped work routing:
// vocabulary, machine advertisement (default-empty = hub posture), routing
// gap, lane env scrub, misroute classifier, stamp verb, and the acceptance
// proofs: a requires-stamped item refuses on an undeclared (hub) machine at
// `work take`, passes once the machine declares the scope, and the shipped
// board chunk renders the credential split.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advertisedCaps,
	assertRequires,
	classifyCredError,
	credRoutingRefusal,
	credScopeGap,
	credScopesOf,
	isCredScope,
	laneProviderEnv,
	machineCredScope,
	stampRequires,
	validScopeToken,
} from "../hooks/lib/cred-scope.ts";
import { TASKS } from "../hooks/board-html/tasks.ts";

setDefaultTimeout(30_000);

describe("credential vocabulary (W1211)", () => {
	test("fixed provider tokens + cloud-/tool- classes", () => {
		expect(isCredScope("gh")).toBe(true);
		expect(isCredScope("az")).toBe(true);
		expect(isCredScope("cloud-gcp")).toBe(true);
		expect(isCredScope("tool-jq")).toBe(true);
		expect(isCredScope("shell")).toBe(false);
		expect(isCredScope("git")).toBe(false);
		expect(isCredScope("GH")).toBe(false);
		expect(isCredScope("cloud-")).toBe(false);
		expect(isCredScope("tool-")).toBe(false);
		expect(isCredScope("gh-with-hyphen")).toBe(false);
	});

	test("full requires vocabulary = runtime caps ∪ credential scopes", () => {
		expect(validScopeToken("browser")).toBe(true);
		expect(validScopeToken("gh")).toBe(true);
		expect(validScopeToken("tool-opencode")).toBe(true);
		expect(validScopeToken("aws")).toBe(false);
	});

	test("assertRequires validates and normalizes the csv", () => {
		expect(assertRequires("git, gh ,mcp")).toBe("git,gh,mcp");
		expect(() => assertRequires("gh,definitely-not-a-scope")).toThrow(
			"unknown scope",
		);
	});

	test("credScopesOf keeps only credential tokens", () => {
		expect(credScopesOf("git,gh,cloud-aws")).toEqual(["gh", "cloud-aws"]);
		expect(credScopesOf(null)).toEqual([]);
	});
});

describe("machine credential scope (W1211) — default empty = hub posture", () => {
	test("an undeclared machine advertises NO provider scope", () => {
		const home = mkdtempSync(join(tmpdir(), "w1211-nodecl-"));
		const file = join(home, "absent.json");
		const prev = process.env.KLH_CRED_SCOPE_FILE;
		process.env.KLH_CRED_SCOPE_FILE = file;
		try {
			expect(machineCredScope()).toEqual([]);
			// and the routing refusal fires for a credentialed item there
			expect(credRoutingRefusal("gh", machineCredScope())).toContain(
				"credential scope gap",
			);
		} finally {
			if (prev === undefined) delete process.env.KLH_CRED_SCOPE_FILE;
			else process.env.KLH_CRED_SCOPE_FILE = prev;
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a declared machine advertises exactly its scopes; garbage fails safe", () => {
		const home = mkdtempSync(join(tmpdir(), "w1211-decl-"));
		const good = join(home, "good.json");
		const bad = join(home, "bad.json");
		const prev = process.env.KLH_CRED_SCOPE_FILE;
		try {
			process.env.KLH_CRED_SCOPE_FILE = good;
			writeFileSync(good, JSON.stringify({ scopes: ["gh", "az", "nope!!"] }));
			expect(machineCredScope()).toEqual(["gh", "az"]); // invalid token dropped
			// a declared scope satisfies the routing law
			expect(credRoutingRefusal("gh,build", machineCredScope())).toBeNull();
			process.env.KLH_CRED_SCOPE_FILE = bad;
			writeFileSync(bad, "{not json");
			expect(machineCredScope()).toEqual([]); // malformed → fail safe
		} finally {
			if (prev === undefined) delete process.env.KLH_CRED_SCOPE_FILE;
			else process.env.KLH_CRED_SCOPE_FILE = prev;
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("credScopeGap names the missing scopes only", () => {
		expect(credScopeGap("git,gh,az", ["az"])).toEqual(["gh"]);
		expect(credScopeGap("git", ["az"])).toEqual([]);
		expect(credScopeGap(null, [])).toEqual([]);
	});
});

describe("routing gate + session caps union (W1211)", () => {
	test("advertisedCaps unions session row with machine scope, deduped", () => {
		expect(advertisedCaps({ capabilities: "shell,git" }, ["gh"])).toEqual([
			"shell",
			"git",
			"gh",
		]);
		expect(advertisedCaps(null, ["gh", "gh"])).toEqual(["gh"]);
		expect(advertisedCaps({ capabilities: null }, [])).toEqual([]);
	});

	test("requires-stamped item is never routable to a hub-advertised lane", () => {
		// hub: CAPS runtime-only (advertisedCaps CAPS ∪ []) + machine scope []
		const hubCaps = advertisedCaps(
			{ capabilities: "shell,fs,git,build,mcp,vision,browser,network" },
			[],
		);
		const missing = credScopeGap("gh", hubCaps);
		expect(missing).toEqual(["gh"]);
		expect(credRoutingRefusal("gh", hubCaps)).toContain("declare it in");
		// credentialed machine declaring gh routes fine
		expect(credScopeGap("gh", [...hubCaps, "gh"])).toEqual([]);
	});
});

describe("lane env scrub (W1211 harness assert) — no provider tokens without declared+required scope", () => {
	test("undeclared machine: hub lane env carries NO gh/az/cloud token vars", () => {
		const env = laneProviderEnv(
			{
				GH_TOKEN: "ghp_secret",
				GITHUB_TOKEN: "y",
				GH_HOST: "x",
				AZURE_CLIENT_ID: "z",
				AZ_CONFIG_DIR: "w",
				AWS_SECRET_ACCESS_KEY: "a",
				CLOUDSDK_CORE_PROJECT: "c",
				GOOGLE_APPLICATION_CREDENTIALS: "/gac.json",
				PATH: "/usr/bin",
				BUCKLE_ADMIN_KEY: "keep-me",
			},
			"git",
			[], // hub declares nothing
		);
		expect(Object.keys(env).sort()).toEqual(["BUCKLE_ADMIN_KEY", "PATH"]);
	});

	test("declared+required scope: only that provider's vars ride", () => {
		const env = laneProviderEnv(
			{ GH_TOKEN: "t", AZURE_CLIENT_ID: "z", PATH: "/bin" },
			"git,gh",
			["gh"],
		);
		expect(env.GH_TOKEN).toBe("t");
		expect(env.AZURE_CLIENT_ID).toBeUndefined();
		expect(env.PATH).toBe("/bin");
	});

	test("required but undeclared → still stripped", () => {
		const env = laneProviderEnv({ GH_TOKEN: "t" }, "gh", []);
		expect(env.GH_TOKEN).toBeUndefined();
	});
});

describe("misroute classifier (W1211 cred-gap-scan)", () => {
	test("provider auth failures name the scope", () => {
		expect(
			classifyCredError(
				"fatal: Authentication failed for 'https://github.com/klh/fleet.git/'",
			),
		).toBe("gh");
		expect(
			classifyCredError(
				"gh: To get started with GitHub, please run: gh auth login",
			),
		).toBe("gh");
		expect(
			classifyCredError("ERROR: AADSTS700016: Application not found"),
		).toBe("az");
		expect(classifyCredError("Please run 'az login' to setup account.")).toBe(
			"az",
		);
		expect(
			classifyCredError(
				"Credentials expired. Run gcloud auth login to reauthenticate",
			),
		).toBe("cloud-gcp");
		expect(
			classifyCredError(
				"Unable to locate credentials. You can configure credentials by running aws configure.",
			),
		).toBe("cloud-aws");
	});

	test("missing binaries classify as tool-<cli> scopes", () => {
		expect(classifyCredError("/bin/sh: command not found: gh")).toBe("gh");
		expect(classifyCredError("/bin/sh: command not found: az")).toBe("az");
		expect(classifyCredError("/bin/sh: command not found: jq")).toBe("tool-jq");
		expect(classifyCredError("/bin/sh: command not found: /x/y/z")).toBe(
			"tool-z",
		);
	});

	test("non-credential lines never false-positive", () => {
		expect(classifyCredError("bun run ./hooks/bin/work.ts take W1")).toBeNull();
		expect(classifyCredError("HTTP 200 OK from buckle front")).toBeNull();
		// GitHub prints this on its OWN line — no github.com context for a
		// per-line classifier; the adjacent fatal '…github.com…' line carries it.
		expect(classifyCredError("remote: Bad credentials")).toBeNull();
		expect(classifyCredError("")).toBeNull();
	});
});

describe("stamp verb face (W1211 audit)", () => {
	const fakeDb = (row: unknown, seen: { run: unknown[] }) => ({
		query: () => ({
			get: () => row,
			run: (...args: unknown[]) => {
				seen.run = args;
			},
		}),
	});

	test("stamps an existing item's requires and emits requires.stamped", () => {
		const seen: { run: unknown[] } = { run: [] };
		const events: Array<[string, string, Record<string, string>]> = [];
		const msg = stampRequires(fakeDb({ id: "W1" }, seen), "P", "W1", "gh,az", {
			die: (m) => {
				throw new Error(m);
			},
			emit: (k, i, e) => {
				events.push([k, i, e]);
			},
		});
		expect(msg).toContain("stamped W1 requires [gh,az]");
		expect(seen.run[0]).toBe("gh,az");
		expect(events).toEqual([["requires.stamped", "W1", { requires: "gh,az" }]]);
	});

	test("unknown scope or missing item dies", () => {
		const die = (m: string): never => {
			throw new Error(m);
		};
		const noop = () => {};
		const db = fakeDb(null, { run: [] });
		expect(() =>
			stampRequires(db, "P", "W1", "bogus!!", { die, emit: noop }),
		).toThrow("unknown scope");
		expect(() =>
			stampRequires(db, "P", "W404", "gh", { die, emit: noop }),
		).toThrow("no such work item");
		expect(() =>
			stampRequires(db, "P", "W1", undefined, { die, emit: noop }),
		).toThrow("usage: stamp");
	});
});

describe("acceptance: work take routing law (real CLI, isolated HOME)", () => {
	const HOME = mkdtempSync(join(tmpdir(), "w1211-take-home-"));
	const REPO = mkdtempSync(join(tmpdir(), "w1211-take-repo-"));
	mkdirSync(join(REPO, ".git"), { recursive: true });
	const HOOKS = join(import.meta.dir, "..", "hooks");
	const env = { ...process.env, HOME };

	const work = (args: string[], extra: Record<string, string> = {}) => {
		const p = Bun.spawnSync(["bun", join(HOOKS, "bin", "work.ts"), ...args], {
			cwd: REPO,
			env: { ...env, ...extra },
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
		};
	};

	test("requires-stamped item refuses on an undeclared machine, passes once declared", () => {
		const add = work(["add", "W1211 cred item", "--requires", "gh"]);
		expect(add.out).toContain("READY");
		const id = /✓ (W\d+|\S+) READY/.exec(add.out)?.[1] ?? "";
		expect(id).not.toBe("");
		// hub posture: no declaration file anywhere in this HOME → refused,
		// and the refusal is the requires gap, not a race
		const refused = work(["take", id, "--as", "w1211hublane"]);
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain("requires [gh]");
		// the refusal left the item claimable (claim refused → still READY)
		const log = work(["show", id]);
		expect(log.out).toContain("READY");
		// declare gh on this machine → the same take passes
		const scope = join(HOME, "credential-scope.json");
		writeFileSync(scope, JSON.stringify({ scopes: ["gh"] }));
		const ok = work(["take", id, "--as", "w1211hublane"], {
			KLH_CRED_SCOPE_FILE: scope,
		});
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("claimed");
	});

	test("runtime-capability requires stay session-gated (no machine widening)", () => {
		const add = work(["add", "W1211 vision item", "--requires", "vision"]);
		const id = /✓ (\S+) READY/.exec(add.out)?.[1] ?? "";
		// no session row for this sid: runtime caps empty, machine scope never
		// carries runtime capabilities → refused with the runtime token named
		const refused = work(["take", id, "--as", "w1211visionlane"], {
			KLH_CRED_SCOPE_FILE: join(HOME, "credential-scope.json"),
		});
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain("requires [vision]");
	});
});

describe("board chunk (W1211) — shipped TASKS bytes render the credential split", () => {
	const start = TASKS.indexOf("function needsCred");
	const end = TASKS.indexOf("function taskGroups");
	const needsCred = new Function(
		`${TASKS.slice(start, end)}\nreturn needsCred;`,
	)() as (csv: unknown) => boolean;

	test("needsCred matches the server vocabulary", () => {
		expect(needsCred("gh")).toBe(true);
		expect(needsCred("git,cloud-aws")).toBe(true);
		expect(needsCred("tool-opencode")).toBe(true);
		expect(needsCred("shell")).toBe(false);
		expect(needsCred(null)).toBe(false);
		expect(needsCred("shell,git")).toBe(false);
	});

	test("kanban card carries the needs chip; count line the split", () => {
		expect(TASKS).toContain("needs ' + esc(String(t.requires))");
		expect(TASKS).toContain("credentialed");
	});
});

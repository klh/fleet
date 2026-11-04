// test/hubctl-repo-tier-policy.e2e.ts — W2632: the compose knob + secret-path
// mount for the hub's repo→tier account policy (W1265.1). The gap (W2596
// receipt): hub buckles booted `account policy active from default:general`
// because the compose template carried no BUCKLE_REPO_TIER_POLICY env and no
// policy mount — minted (non-root) keys hit 503 buckle.tier_no_upstream on
// copilot-backed rows. Pinned here, both directions:
//   - stack.json hubs.<label>.secrets.repo_tier_policy declared → render
//     emits HUB_REPO_TIER_POLICY (the fixed container path) and push stages
//     the operator's 0600 file beside the compose as the bind source;
//   - undeclared → render emits NO knob line and push stages an EMPTY
//     placeholder (the bind source is always a file, never a directory);
//   - declared-but-missing (local path) → push refuses loudly (fail closed,
//     the W1123 posture at deploy time — a broken boundary never silently
//     stages from nowhere).
// The compose template face itself (env passthrough + :ro mount) is pinned
// by hub-compose-hardening's parse of the same template file.
import { expect, test } from "@playwright/test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubctlRouteFixture } from "./support/hubctl-route-fixture.ts";

test.describe("@unit", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-hub-tier-"));
	mkdirSync(dir, { recursive: true });
	const deployDir = join(dir, "hub");
	mkdirSync(deployDir, { recursive: true });
	const stack = join(dir, "stack.json");
	const policySource = join(dir, "operator-policy.yaml");
	writeFileSync(
		policySource,
		[
			"version: 1",
			"classes:",
			"  - id: test-general",
			"    tier: test",
			"    general: true",
			'    keys: ["*"]',
			"    providers: [zai]",
			"",
		].join("\n"),
	);

	function stackDoc(secrets: Record<string, string> | undefined) {
		return {
			version: "v2632-test",
			auth: { required: false },
			hubs: {
				hub: {
					host: "127.0.0.1",
					buckle_port: 14511,
					deploy: { dir: deployDir },
					...(secrets ? { secrets } : {}),
				},
			},
		};
	}

	function hubctl(args, secrets) {
		writeFileSync(stack, JSON.stringify(stackDoc(secrets), null, "\t"));
		const r = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), ...args],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					...hubctlRouteFixture(dir),
					KLH_STACK: stack,
				},
			},
		);
		return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
	}

	test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("declared knob renders HUB_REPO_TIER_POLICY and push stages the operator file", () => {
		const render = hubctl(["render", "hub"], {
			repo_tier_policy: policySource,
		});
		expect(render.code).toBe(0);
		expect(render.out).toContain(
			"HUB_REPO_TIER_POLICY=/etc/klh/repo-tier-policy.yaml",
		);

		const push = hubctl(["push", "hub"], {
			repo_tier_policy: policySource,
		});
		expect(push.out).not.toContain("Error");
		const staged = readFileSync(
			join(deployDir, "repo-tier-policy.yaml"),
			"utf8",
		);
		expect(staged).toContain("id: test-general");
	});

	test("undeclared knob renders no line and push stages an EMPTY placeholder", () => {
		const render = hubctl(["render", "hub"], undefined);
		expect(render.code).toBe(0);
		expect(render.out).not.toContain("HUB_REPO_TIER_POLICY");

		const push = hubctl(["push", "hub"], undefined);
		expect(push.out).not.toContain("Error");
		expect(push.out).toContain("empty placeholder");
		const staged = readFileSync(
			join(deployDir, "repo-tier-policy.yaml"),
			"utf8",
		);
		expect(staged).toBe("");
	});

	test("declared-but-missing source refuses push (fail closed)", () => {
		const push = hubctl(["push", "hub"], {
			repo_tier_policy: join(dir, "no-such-policy.yaml"),
		});
		expect(push.code).not.toBe(0);
		expect(push.out).toContain("configured but missing");
	});

	test("source IS the staged deploy file — no self-truncating copy", () => {
		// the operator may keep the policy at <deploy-dir>/repo-tier-policy.yaml
		// itself; `cat src > dst` on the same file truncates before cat reads,
		// destroying the policy. The guard chmods in place instead.
		const stagedPath = join(deployDir, "repo-tier-policy.yaml");
		writeFileSync(stagedPath, "version: 1\n"); // deliberately tiny
		const push = hubctl(["push", "hub"], { repo_tier_policy: stagedPath });
		expect(push.out).not.toContain("Error");
		expect(push.out).toContain("already staged");
		expect(readFileSync(stagedPath, "utf8")).toBe("version: 1\n");
	});
});

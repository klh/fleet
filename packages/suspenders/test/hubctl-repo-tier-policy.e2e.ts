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
import { runCli, scratchWorld } from "@klh/test-kit";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubctlRouteFixture } from "./support/hubctl-route-fixture.ts";

test.describe("@unit", () => {
	// W2684 N2: scratch fixture + CLI spawn ride @klh/test-kit (W1135.1.3)
	const world = scratchWorld({ prefix: "fleet-hub-tier-" });
	const dir = world.repo;
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
		const r = runCli(join(import.meta.dir, "../deploy/hubctl.ts"), args, {
			env: {
				...world.env,
				...hubctlRouteFixture(dir),
				KLH_STACK: stack,
			},
		});
		return { code: r.code, out: r.out + r.err };
	}

	const sshDeployDir = join(dir, "hub-ssh");
	// fake ssh: the LAST argv element is the script; run it via /bin/sh in
	// THIS shell — good enough to prove cat-chain exit codes. fake scp:
	// strip the host: prefix and copy stdin (pushConfig's compose template
	// leg runs BEFORE the policy stage and must not fail the probe).
	function writeSshShim(bin: string): void {
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "ssh"),
			'#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nexec /bin/sh -c "$1"\n',
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "scp"),
			// no ${...} shells expansion literals (biome noTemplateCurlyInString):
			// cut strips the host: prefix instead of parameter expansion
			'#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\ndest=$(printf %s "$1" | cut -d: -f2-)\ncat > "$dest"\n',
			{ mode: 0o755 },
		);
		chmodSync(join(bin, "ssh"), 0o755);
		chmodSync(join(bin, "scp"), 0o755);
	}
	function sshPush(bin: string, remoteSource: string) {
		mkdirSync(sshDeployDir, { recursive: true });
		writeFileSync(
			stack,
			JSON.stringify(
				{
					version: "v2632-test",
					auth: { required: false },
					hubs: {
						hub: {
							host: "127.0.0.1",
							buckle_port: 14512,
							deploy: { ssh: "kk@hub.test", dir: sshDeployDir },
							secrets: { repo_tier_policy: remoteSource },
						},
					},
				},
				null,
				"\t",
			),
		);
		return sshHubctl(bin, ["push", "hub"]);
	}
	function sshHubctl(bin: string, args: string[]) {
		const r = runCli(join(import.meta.dir, "../deploy/hubctl.ts"), args, {
			env: {
				...world.env,
				...hubctlRouteFixture(dir),
				KLH_STACK: stack,
				PATH: `${bin}:${process.env.PATH}`,
			},
		});
		return { code: r.code, out: r.out + r.err };
	}

	test.afterAll(() => world.clean());

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

	test("ssh hub with a missing remote source fails push, never stages EMPTY", () => {
		// W2684 N2: on an ssh hub the local existsSync preflight cannot run,
		// so the remote cat must be `-chained — a `;`-chained cat would
		// truncate dest and exit 0, staging an EMPTY policy as the bind
		// source (a silently disabled boundary). The fake ssh runs the
		// script through /bin/sh locally: the missing source proves the
		// chain propagates cat's failure to the push exit code.
		const sshBin = join(dir, "bin");
		mkdirSync(sshBin, { recursive: true });
		writeSshShim(sshBin);
		const r = sshPush(sshBin, join(dir, "no-such-remote-policy.yaml"));
		expect(r.code).not.toBe(0);
		expect(r.out).not.toContain("staged from");
		// NB the shell redirect truncates dest even under && — an empty
		// remnant may exist — but the push FAILS LOUD (never reaches `up`)
		// and buckle fails closed booting an empty policy (no classes
		// list), so no silent-disable path remains.
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

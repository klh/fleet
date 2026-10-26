// e2e/ent-fixture-module.ts — W775.1 TEST FIXTURE, never shipped: the
// enterprise provider double the e2e loads via KLH_OVERLAY_MODULE to
// exercise the entitled GUI against the real seam routes. Canned but
// honest payloads — one failed slice (vault) proves the honest
// empty-state renders. The real implementation lives in the private
// overlay (klh-remote), not here.
import type { EnterpriseFactory } from "../../hooks/board/ent-seam.ts";

export const enterpriseProvider: EnterpriseFactory = () => ({
	entitlements: () => ({
		ok: true,
		sku: "enterprise",
		tenant: "acme-corp",
		panels: [
			"identity",
			"federation",
			"audit",
			"usage",
			"policy",
			"vault",
			"ma",
		],
	}),
	panels: () => ({
		ok: true,
		ts: Date.now(),
		panels: {
			identity: {
				ok: true,
				users: [
					{
						id: "u1",
						label: "ada",
						kind: "employee",
						roles: ["admin"],
						mfa: "enforced",
						entitled: true,
					},
					{
						id: "u2",
						label: "bob (external)",
						kind: "contractor",
						roles: [],
						mfa: "off",
						entitled: false,
					},
				],
				roles: [
					{ id: "admin", members: 1, scopes: ["vault:read"] },
					{ id: "ops", members: 1, scopes: ["deploy"] },
				],
				oidc: { issuer: "https://login.example", enforced: true },
			},
			federation: {
				ok: true,
				peers: [
					{
						spoke_id: "spoke-lab",
						state: "enrolled",
						version: "1.2.0",
						policy_version: "p7",
						region: "eu-central",
						last_seen: Date.now() - 60_000,
					},
					{
						spoke_id: "spoke-old",
						state: "stale",
						version: "1.0.4",
						policy_version: null,
						region: "us-east",
						last_seen: Date.now() - 86_400_000 * 9,
					},
				],
			},
			audit: {
				ok: true,
				entries: [
					{
						ts: Date.now() - 3_600_000,
						actor: "owner",
						action: "policy.apply",
						target: "p7",
						outcome: "ok",
					},
					{
						ts: Date.now() - 7_200_000,
						actor: "unknown",
						action: "auth.login",
						target: "board",
						outcome: "denied",
					},
				],
			},
			usage: {
				ok: true,
				departments: [
					{
						id: "platform",
						label: "platform",
						spend_tok: 1_240_000,
						cap_tok: 2_000_000,
						anomaly: false,
					},
					{
						id: "support",
						label: "support",
						spend_tok: 980_000,
						cap_tok: 500_000,
						anomaly: true,
					},
				],
			},
			policy: {
				ok: true,
				versions: [
					{
						version: "p7",
						rollout: "active",
						signed: true,
						pinned_by: 12,
					},
					{
						version: "p8-rc1",
						rollout: "canary",
						signed: true,
						pinned_by: null,
					},
				],
				cr_queue: 3,
				overrides: ["emergency-hotfix-41"],
			},
			vault: {
				ok: false,
				why: "vault surface not wired on this hub",
			},
			ma: {
				ok: true,
				transfers: [
					{
						ts: Date.now() - 172_800_000,
						dept: "support",
						spoke_id: "spoke-lab",
						outcome: "done",
					},
				],
				revocations: [
					{
						id: "u9 (external)",
						dept: "support",
						at: Date.now() - 2_592_000_000,
					},
				],
			},
		},
	}),
});

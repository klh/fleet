// deploy/hub-credential.ts — W2321.1: the MACHINE's hub credential (the
// token hubs.json projects from stack hubs.<label>.token_file) re-minted
// with the scopes the dispatch authority needs hub-side. The W615 hub-won
// attribution path mints per-lane bksk_ keys AT the hub
// (hooks/lib/lanes/lane-auth.ts mintLaneKey → POST /v1/admin/keys), which
// demands buckle:admin:WRITE_ — the cache-read keys the registry carried
// answer 403 insufficient_scope and every hub-pinned dispatch fails
// closed (W463). Same mint exec as lane/service keys (runMintOnHub: the
// root credential is read ON the hub, never printed or transported).
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import { runMintOnHub, type ServiceKeyRunner } from "./service-key.ts";

/** W2321.1: the ONE scope set a machine's hub credential carries. Every
 *  consumer of the hubs.json token, verified against the hub's gate:
 *  - admin:WRITE_ (⊃ admin:READ_) — dispatch lane-key mint + revoke
 *    (launch-cleanup), GET /federation/usage rollup (cross-hub-usage)
 *  - spoke:READ_ — GET /federation/policy-manifest (federation-peers)
 *  - proxy:READ_ — GET /v1/models catalog (model-health fetchHubCatalog)
 *  No proxy WRITE_: the credential routes reads and mints lane keys; the
 *  lanes themselves ride their own minted keys. */
export const HUB_CREDENTIAL_SCOPES: readonly string[] = [
	"buckle:admin:WRITE_",
	"buckle:spoke:READ_",
	"buckle:proxy:READ_",
];

/** W2321.1: mint the machine's hub credential ON the hub (persistent — no
 *  expires_in_s, same posture as a service key) and land the raw material
 *  atomically at 0600 in outPath (metadata only on stdout). The operator
 *  then points stack.json hubs.<label>.token_file at outPath and re-runs
 *  the registry projection (install seedLocalLlm / writeHubRegistry). */
export function mintHubCredential(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	outPath: string,
): void {
	runMintOnHub(
		runner,
		hub,
		hubName,
		JSON.stringify({
			name: `machine-hub-credential-${hubName}`,
			scopes: HUB_CREDENTIAL_SCOPES,
		}),
		outPath,
	);
}

/** The hubctl case arm (traceTunnelVerb precedent): the verb owns its
 *  flag parsing, usage line and exit codes (2 usage; mint failures exit 1
 *  inside runMintOnHub's parse tail). */
export function mintHubCredentialVerb(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	flags: string[],
): void {
	const i = flags.indexOf("--out");
	const out = i >= 0 ? flags[i + 1] : undefined;
	if (out === undefined) {
		console.log(
			"usage: hubctl mint-hub-credential <hub> --out <keyfile> — machine credential (admin:WRITE_/spoke:READ_/proxy:READ_, persistent) into --out (0600); point stack.json hubs.<label>.token_file at it",
		);
		process.exit(2);
	}
	mintHubCredential(runner, hub, hubName, out);
}

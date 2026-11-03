// deploy/hub-parity-probe.ts — the hub-side exec leg for hubctl parity
// (W2595). Extracted so hubctl.ts stays a thin verb dispatcher: this is
// the ONE sh script that mints a 120s lane key ON the hub (raw key rides
// the runner stdout once — never argv, never hub disk) and POSTs one
// /v1/messages body through the hub's own gate with it, printing only the
// HTTP status. Same runner interface as service-key.ts.
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import type { ServiceKeyRunner } from "./service-key.ts";

const BS = String.fromCharCode(92);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BSDQ = BS + DQ;
const SED_KEY =
	"s/.*" +
	DQ +
	"key" +
	DQ +
	":" +
	DQ +
	BS +
	"([^" +
	DQ +
	"]*" +
	BS +
	")" +
	".*/" +
	BS +
	"1/p";

const PROBE_LINES = [
	"umask 077",
	"K=$(sed -n " +
		SQ +
		"s/^BUCKLE_ROOT_KEY=//p" +
		SQ +
		" " +
		DQ +
		"$1" +
		DQ +
		" | head -n1 | tr -d " +
		SQ +
		BS +
		"r" +
		BS +
		"n" +
		SQ +
		")",
	"[ -n " +
		DQ +
		"$K" +
		DQ +
		" ] || { echo " +
		DQ +
		"hub root key missing at $1" +
		DQ +
		" >&2; exit 3; }",
	`M=$(curl --max-time 15 -sS -X POST ${BS}`,
	"  -H " +
		DQ +
		"Authorization: Bearer $K" +
		DQ +
		" -H " +
		DQ +
		"content-type: application/json" +
		DQ +
		" " +
		BS,
	"  -d " +
		SQ +
		'{"name":"parity-probe","scopes":["buckle:proxy:WRITE_"],"expires_in_s":120}' +
		SQ +
		" " +
		BS,
	`  ${DQ}http://127.0.0.1:$2/v1/admin/keys${DQ})`,
	"LK=$(printf %s " +
		BSDQ +
		"$M" +
		BSDQ +
		" | sed -n " +
		SQ +
		SED_KEY +
		SQ +
		")",
	"[ -n " +
		DQ +
		"$LK" +
		DQ +
		" ] || { echo " +
		DQ +
		"parity: no lane key minted" +
		DQ +
		" >&2; exit 4; }",
	"B=$(cat)",
	`curl --max-time 30 -sS -o /dev/null -X POST ${BS}`,
	"  -H " +
		DQ +
		"Authorization: Bearer $LK" +
		DQ +
		" -H " +
		DQ +
		"content-type: application/json" +
		DQ +
		" " +
		BS,
	"  -d " +
		DQ +
		"$B" +
		DQ +
		" -w " +
		SQ +
		"%{http_code}" +
		SQ +
		" " +
		DQ +
		"http://127.0.0.1:$2/v1/messages" +
		DQ,
];
const PROBE_SCRIPT = PROBE_LINES.join("\n");

const quote = (a: string): string =>
	SQ + a.replaceAll(SQ, SQ + BS + SQ + SQ) + SQ;

/** Mint the 120s parity lane key and POST one body; answer = HTTP status.
 *  Throws the runner's error on an unreachable hub (the caller maps that
 *  to an `unreachable` verdict row). */
export function probeHubMessages(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	body: Record<string, unknown>,
): number {
	const port = hub.buckle_port;
	const root = hub.secrets?.buckle_root_key;
	if (!port || !root)
		throw new Error(
			`hub ${hubName} needs buckle_port + secrets.buckle_root_key in stack.json`,
		);
	const out = runner(
		hub,
		"/bin/sh -c " +
			quote(PROBE_SCRIPT) +
			" sh " +
			quote(root) +
			" " +
			quote(String(port)),
		{ input: JSON.stringify(body) },
	);
	return Number(out.trim().split("\n").at(-1));
}

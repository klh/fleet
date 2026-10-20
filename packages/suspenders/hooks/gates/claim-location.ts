// gates/claim-location.ts — W870: the location-vs-claim deny, wired into the
// pre-files chain between content and governor — payload integrity first,
// then location, then leases (a refused location must never take a lease).
// Fail open on any registry trouble: a dead registry never blocks an edit.
import { deny, type HookInput } from "../lib/hookio.ts";
import { openStore } from "../lib/govdb.ts";
import { claimLocationCheck, locationExempt } from "../lib/claim-location.ts";
import { subagentLaneSuffix } from "../lib/subscribe-attach.ts";

export function claimLocationGate(hook: HookInput): void {
	const ti = hook.tool_input ?? {};
	const F: string = ti.file_path ?? ti.notebook_path ?? "";
	if (!F) return;
	const sid = hook.session_id ?? "";
	const parent = sid.split("#")[0];
	if (!parent) return;
	const suffix = subagentLaneSuffix(hook.transcript_path ?? "");
	const lane = suffix ? `${parent}${suffix}` : sid;
	const isChild = Boolean(suffix || sid.includes("#"));
	// governor EXEMPT sessions skip location too; subagents never inherit the
	// exemption (same contract as the governor's own exempt check)
	if (!isChild && locationExempt(parent)) return;
	try {
		const v = claimLocationCheck(F, lane, openStore(), {
			requireProvisionedClaim: isChild,
		});
		if (v.blocked) deny(v.reason);
	} catch {
		// registry unavailable — allow, the outage ledger covers governor's db
	}
}

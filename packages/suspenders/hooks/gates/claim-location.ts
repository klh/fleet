// gates/claim-location.ts — W870: the location-vs-claim deny, wired into the
// pre-files chain between content and governor — payload integrity first,
// then location, then leases (a refused location must never take a lease).
// Fail open on any registry trouble: a dead registry never blocks an edit.
import { deny, type HookInput } from "../lib/hookio.ts";
import { openStore } from "../lib/govdb.ts";
import { claimLocationCheck, locationExempt } from "../lib/claim-location.ts";

export function claimLocationGate(hook: HookInput): void {
	const ti = hook.tool_input ?? {};
	const F: string = ti.file_path ?? ti.notebook_path ?? "";
	if (!F) return;
	const lane = (hook.session_id ?? "").split("#")[0];
	if (!lane) return;
	// governor EXEMPT sessions skip location too; subagents never inherit the
	// exemption (same contract as the governor's own exempt check)
	const isSubagent = (hook.transcript_path ?? "").includes("/subagents/");
	if (!isSubagent && locationExempt(hook.session_id ?? "")) return;
	try {
		const v = claimLocationCheck(F, lane, openStore());
		if (v.blocked) deny(v.reason);
	} catch {
		// registry unavailable — allow, the outage ledger covers governor's db
	}
}

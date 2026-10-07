import {
	digestUnit,
	inspectServices,
	retainActivation,
	type ActivationReceipt,
	type ActivationService,
	type Inspect,
} from "./service-drift.ts";
import type { processBirth } from "./launch-fencing.ts";
import { identityMatches } from "./owned-process.ts";

export interface ExistingServiceDeps {
	inspect: Inspect;
	read: (path: string) => string;
	birth: typeof processBirth;
	publish: (receipt: ActivationReceipt) => void;
}
/** Explicit owner intent only: validate an already-loaded exact definition, never start or stop it. */
export function recordExistingService(
	receipt: ActivationReceipt,
	service: ActivationService,
	expectedUnit: string,
	previous: ActivationReceipt | undefined,
	deps: ExistingServiceDeps,
): number {
	if (
		digestUnit(expectedUnit) !== service.unitSha256 ||
		digestUnit(deps.read(service.unit)) !== service.unitSha256
	)
		throw new Error("existing unit differs from reviewed declaration");
	const candidate = { ...receipt, services: [service] };
	const first = inspectServices(
		candidate,
		receipt.domain,
		receipt.manifest,
		deps.inspect,
		deps.read,
	)[0];
	if (first?.state !== "running" || !first.pid)
		throw new Error("existing supervised service is not verified running");
	const birth = deps.birth(first.pid);
	if (!birth) throw new Error("existing process start identity unavailable");
	const second = inspectServices(
		candidate,
		receipt.domain,
		receipt.manifest,
		deps.inspect,
		deps.read,
	)[0];
	if (
		second?.state !== "running" ||
		second.pid !== first.pid ||
		!identityMatches(birth, deps.birth(first.pid))
	)
		throw new Error(
			"existing supervised process changed during reconciliation",
		);
	deps.publish(retainActivation(candidate, previous));
	return first.pid;
}

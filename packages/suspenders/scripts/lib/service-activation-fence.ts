import { digestUnit, type ActivationReceipt } from "./service-drift.ts";

/** Existing explicit activation intent is authority; rendering is not approval. */
export function assertServiceActivation(
	receipt: ActivationReceipt | undefined,
	label: string,
	candidate: string,
	args: string[],
	manifest: string,
	domain: string,
	initialInstall = false,
	confirmedAbsent = false,
): void {
	const service = receipt?.services.find((entry) => entry.label === label);
	if (!service && initialInstall && confirmedAbsent) return;
	if (
		receipt?.domain !== domain ||
		receipt?.manifestSha256 !== digestUnit(manifest) ||
		!service ||
		service.unitSha256 !== digestUnit(candidate) ||
		JSON.stringify(service.arguments) !== JSON.stringify(args)
	)
		throw new Error(
			"activation refused: candidate differs from explicit approved service intent",
		);
}

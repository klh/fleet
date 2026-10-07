import type { StatusDoc, TargetStatus } from "./supervisor.ts";

export function supervisorSource(
	doc: { source?: unknown } | StatusDoc,
): string {
	return "source" in doc && doc.source === "local-llm-serve"
		? "local-llm-serve"
		: "belt-supervisor";
}

export function restartEvidence(target: {
	restarts?: number | null;
	restartsLastWindow?: number | null;
}): string {
	return `${target.restartsLastWindow ?? "not recorded"} restarts in budget window · ${target.restarts ?? "not recorded"} total`;
}

/** Supervisor state is useful only while its independent probes are recent. */
export function supervisorFresh(
	doc: StatusDoc | null,
	now = Date.now(),
): boolean {
	if (!doc || !Number.isFinite(doc.intervalMs) || doc.intervalMs <= 0)
		return false;
	const updated = Date.parse(doc.updated);
	return (
		Number.isFinite(updated) &&
		updated <= now + 5_000 &&
		now - updated <= Math.max(15_000, doc.intervalMs * 3)
	);
}

export function endpointState(
	up: boolean,
	target: TargetStatus | undefined,
	doc: StatusDoc | null,
	now = Date.now(),
): string {
	// A direct probe cannot prove health, but does prove the endpoint listens.
	if (!supervisorFresh(doc, now) || !target)
		return up ? "listening" : "not listening";
	const lastProbe = Date.parse(target.lastProbe ?? "");
	if (
		!Number.isFinite(lastProbe) ||
		lastProbe > now + 5000 ||
		now - lastProbe > Math.max(15_000, (doc?.intervalMs ?? 0) * 3)
	)
		return up ? "listening" : "not listening";
	if (target.preflightError) return "dependency blocked";
	if (!up && target.kind === "ondemand" && target.state === "idle")
		return "idle · on demand";
	if (target.state === "unhealthy") return "restart limit reached";
	if (target.state === "backoff") return "retry scheduled";
	if (up && target.state === "up") return "ready";
	if (!up && target.state === "up") return "probe disagreement";
	return target.state;
}

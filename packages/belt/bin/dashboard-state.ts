import type { StatusDoc, TargetStatus } from "./supervisor.ts";

/** Supervisor state is useful only while its independent probes are recent. */
export function supervisorFresh(
	doc: StatusDoc | null,
	now = Date.now(),
): boolean {
	if (!doc) return false;
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
	if (target.preflightError) return "dependency blocked";
	if (!up && target.kind === "ondemand" && target.state === "idle")
		return "idle · on demand";
	if (target.state === "unhealthy") return "restart limit reached";
	if (target.state === "backoff") return "retry scheduled";
	if (up && target.state === "up") return "ready";
	if (!up && target.state === "up") return "probe disagreement";
	return target.state;
}

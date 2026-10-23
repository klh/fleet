/** Darwin's kern.boottime is wall-clock derived and can change while a
 * process remains alive. Never use it as a durable boot incarnation. */
export function darwinProcessBirth(
	bootSession: string | null,
	start: string,
): string | null {
	return bootSession &&
		/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(bootSession) &&
		/^\d+:\d+$/.test(start)
		? `darwin:${bootSession.toLowerCase()}:${start}`
		: null;
}

export const obsoleteDarwinBirth = (birth: string): boolean =>
	birth.startsWith("{ sec = ");

/** An old wall-clock-derived record is uncertainty, never proof of PID reuse.
 * Explicit operator reconciliation is the only way to replace that record. */
export function compareProcessBirth(
	recorded: string,
	current: string,
): "same" | "different" | "unknown" {
	if (obsoleteDarwinBirth(recorded) || obsoleteDarwinBirth(current))
		return "unknown";
	return recorded === current ? "same" : "different";
}

/** Evidence for explicit repair only. This is NOT an identity comparator. */
export function obsoleteProcessStart(recorded: string): string | null {
	if (!obsoleteDarwinBirth(recorded)) return null;
	return /:(\d+:\d+)$/.exec(recorded)?.[1] ?? null;
}

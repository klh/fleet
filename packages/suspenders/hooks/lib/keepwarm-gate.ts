// hooks/lib/keepwarm-gate.ts — W1124.14: every cloud-drill leg of the
// keepwarm pass is operator opt-in, default OFF. 30-40 ramp evidence: with
// refill held, Buckle recent requests kept showing prefix-keepwarm and
// cache-drill model calls every 240s pass — idle inference the owner
// explicitly declined (account1302 repair blocked); the review correction
// added the W219.2 fallback drill's real glm completion to the same gate.
// What stays default-on: local liveness (tier pings, remote probes) and
// GET/network reachability probes — liveness, never automatic completions.
// No endpoint/model hardcodes, no global maintenance disable, no forced
// deletes: the captured prefix file is untouched; opt-in re-arms as before.

/** Truthy parse for explicit opt-in knobs. Only 1/true/yes/on (trimmed,
 *  case-insensitive) enables; absent, empty, or any other value is OFF — an
 *  empty string counts as NOT set (never `?? fallback` on env). */
export function optInEnabled(value: string | undefined): boolean {
	const v = value?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** W623 cloud prefix warm replay: explicit operator opt-in, default OFF. */
export const prefixWarmEnabled = (
	env: Record<string, string | undefined> = process.env,
): boolean => optInEnabled(env.BELT_PREFIX_KEEPWARM_ENABLED);

/** W901.1 cloud cache-share drill: explicit operator opt-in, default OFF. */
export const cacheDrillEnabled = (
	env: Record<string, string | undefined> = process.env,
): boolean => optInEnabled(env.BELT_CACHE_DRILL_ENABLED);

/** W219.2 gateway fallback drill (the real glm completion half): explicit
 *  operator opt-in, default OFF. The GET reachability probe + live-config
 *  ladder assertion stay default-on — liveness, not inference. */
export const fallbackDrillEnabled = (
	env: Record<string, string | undefined> = process.env,
): boolean => optInEnabled(env.BELT_FALLBACK_DRILL_ENABLED);

/** W1119.2 gated warm set: tier-manifest warm_ports ∩ the emitted
 *  direct-tiers catalog (port → alias via the base URL). Chat aliases ride
 *  the gate (model-as-data, prefer-local); ports with no chat alias (the
 *  rerank rung, for one) drop — the gate owns inference, a bare port
 *  cannot be warmed through it. */
export function warmTargets(
	tier: { warm_ports?: unknown },
	catalog: Record<string, unknown>,
): { port: number; alias: string }[] {
	const ports =
		Array.isArray(tier.warm_ports) &&
		tier.warm_ports.every((p) => typeof p === "number" && p > 0 && p < 65536)
			? tier.warm_ports
			: [];
	const byPort = new Map<number, string>();
	for (const [alias, base] of Object.entries(catalog)) {
		if (typeof base !== "string") continue;
		try {
			const port = Number(new URL(base).port);
			if (port > 0) byPort.set(port, alias);
		} catch {
			// malformed catalog row — not warmable
		}
	}
	return ports.flatMap((port) => {
		const alias = byPort.get(port);
		return alias ? [{ port, alias }] : [];
	});
}

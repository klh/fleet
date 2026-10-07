export type DnsClaim = { claimed: boolean; pid?: number };

export function activeRouteMatches(
	config: unknown,
	host: string,
	target: string,
): boolean {
	const root = config as {
		apps?: { http?: { servers?: Record<string, { routes?: unknown[] }> } };
	};
	const hasProxy = (value: unknown): boolean => {
		if (!value || typeof value !== "object") return false;
		if (Array.isArray(value)) return value.some(hasProxy);
		const row = value as Record<string, unknown>;
		if (row.handler === "reverse_proxy" && Array.isArray(row.upstreams))
			return row.upstreams.some((upstream) => upstream?.dial === target);
		return Object.values(row).some(hasProxy);
	};
	return Object.values(root?.apps?.http?.servers ?? {}).some((server) =>
		(server.routes ?? []).some((route) => {
			const row = route as { match?: { host?: string[] }[]; handle?: unknown };
			return (
				row.match?.some((match) => match.host?.includes(host)) &&
				hasProxy(row.handle)
			);
		}),
	);
}

/** Refresh only the DNS claim; caller holds the registry lock. */
export function reconcileDnsClaim(options: {
	current: DnsClaim;
	matches: (pid: number) => boolean;
	spawn: () => DnsClaim;
	publish: (claim: DnsClaim) => void;
	cleanupNew: (pid: number) => void;
}): "unchanged" | "reconciled" {
	if (
		options.current.claimed &&
		options.current.pid &&
		options.matches(options.current.pid)
	)
		return "unchanged";
	const claim = options.spawn();
	try {
		if (!claim.claimed || !claim.pid || !options.matches(claim.pid))
			throw new Error("new DNS claimant did not register its expected process");
		options.publish(claim);
		return "reconciled";
	} catch (error) {
		if (claim.pid) options.cleanupNew(claim.pid);
		throw error;
	}
}

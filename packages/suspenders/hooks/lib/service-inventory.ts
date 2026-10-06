// Model identity comes from Belt's deployed registry, never a second port list.
import { existsSync } from "node:fs";
import type { RegistryEntry, ROUTER } from "../../../belt/bin/registry.ts";
export { probePathFor } from "./inventory-probe.ts";

const candidates = [
	process.env.BELT_REGISTRY ?? "",
	new URL("../../../belt/bin/registry.ts", import.meta.url).pathname,
	`${process.env.HOME}/.claude/local-llm/registry.ts`,
];
const path = candidates.find((p) => existsSync(p));
const registry = path
	? ((await import(path)) as {
			registryEntries?: () => RegistryEntry[];
			ROUTER: typeof ROUTER;
		})
	: null;
export const MODEL_INVENTORY: readonly RegistryEntry[] = Object.freeze(
	registry?.registryEntries?.() ?? [],
);
export const ROUTER_INVENTORY = registry?.ROUTER;

export interface ServiceRegistration {
	name: string;
	port: number;
	created: string;
	upstream?: string;
}

// A remote registration must never inherit a local port's readiness. Join on
// its actual configured upstream; registrations without one target loopback.
export function registrationPort(s: ServiceRegistration): number | null {
	if (!s.upstream) return s.port;
	try {
		const u = new URL(s.upstream);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null;
		return Number(u.port || (u.protocol === "https:" ? 443 : 80));
	} catch {
		return null;
	}
}

export function matchingRegistrations(
	port: number,
	registrations: ServiceRegistration[],
): ServiceRegistration[] {
	return registrations.filter((s) => registrationPort(s) === port);
}

// hooks/lib/federation/profile.ts — W165 capability flags: the shared grammar that keeps
// spoke and hub installs in sync. Owner law (federation doc, capability-split
// section): spoke machines ship NO auth issuance / identity administration /
// key custody — toward the hub a spoke presents the enrollment token as a
// client credential and never verifies anyone; local trust is the loopback.
// sync-harness.ts writes capabilities.json at the prefix root with the
// hub-only flags off AND excludes the hub-only modules (hooks/lib/auth/auth.ts,
// hooks/lib/auth/auth-server.ts, hooks/bin/auth.ts, hooks/lib/auth/hub-tokens.ts,
// hooks/board/routes-hub-admin.ts) from the copied harness; hub (default) =
// full profile — the
// single-machine dev case (hub==spoke, this box) runs the default install.
// Missing capabilities.json = no profile was chosen = hub (backward compat).
// A PRESENT but unreadable file fails SAFE: hub-only capabilities stay OFF
// (no auth code runs where the operator asked for a profile and left it
// unparseable). The same names ride the federation policy pull
// (buckle FedManifest.capabilities — pinned together by test/profile.test.ts)
// so a spoke never expects hub-only surfaces.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── canonical names (the shared grammar — buckle mirrors these) ────────────
export const CAP_ROUTING = "routing";
export const CAP_ADAPTERS = "adapters";
export const CAP_AIDS_METERING = "aids_metering";
export const CAP_PULL_CLIENT = "pull_client";
export const CAP_AUTH_ISSUANCE = "auth_issuance";
export const CAP_IDENTITY_ADMIN = "identity_admin";
export const CAP_KEY_CUSTODY = "key_custody";

/** Both variants ship these; hub-only never lands on a spoke. */
export const SHARED_CAPABILITIES = [
	CAP_ROUTING,
	CAP_ADAPTERS,
	CAP_AIDS_METERING,
	CAP_PULL_CLIENT,
] as const;
export const HUB_ONLY_CAPABILITIES = [
	CAP_AUTH_ISSUANCE,
	CAP_IDENTITY_ADMIN,
	CAP_KEY_CUSTODY,
] as const;
export const ALL_CAPABILITIES = [
	...SHARED_CAPABILITIES,
	...HUB_ONLY_CAPABILITIES,
] as const;

export type CapabilityName = (typeof ALL_CAPABILITIES)[number];

export interface CapabilityFlags {
	routing: boolean;
	adapters: boolean;
	aids_metering: boolean;
	pull_client: boolean;
	auth_issuance: boolean;
	identity_admin: boolean;
	key_custody: boolean;
}

/** Hub profile = full (identity, issuance, admin) — also the single-machine
 *  dev case (hub==spoke). */
export function hubCapabilities(): CapabilityFlags {
	return {
		routing: true,
		adapters: true,
		aids_metering: true,
		pull_client: true,
		auth_issuance: true,
		identity_admin: true,
		key_custody: true,
	};
}

/** Spoke profile: the shared grammar rides along; the hub-only trio never
 *  ships. */
export function spokeCapabilities(): CapabilityFlags {
	return {
		routing: true,
		adapters: true,
		aids_metering: true,
		pull_client: true,
		auth_issuance: false,
		identity_admin: false,
		key_custody: false,
	};
}

// ─── resolution ──────────────────────────────────────────────────────────────

// LIVE env read (the auth.ts secretsHome pattern); KLH_CAPABILITIES_FILE
// overrides for tests and nonstandard homes. Default: installed prefix =
// Bun realpaths import.meta.path, so the payload copy (reached via the
// lib/ symlink) reports .harness/…/hooks/lib — walk up to the dir that
// owns .harness, where sync-harness.ts writes the file (W736). No .harness
// ancestor (repo checkout, tests) keeps the hooks-beside-lib fallback.
export function capabilitiesFile(): string {
	const override = process.env.KLH_CAPABILITIES_FILE?.trim();
	if (override !== undefined && override.length > 0) return override;
	const lib = dirname(import.meta.path);
	let dir = dirname(lib);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, ".harness")))
			return join(dir, "capabilities.json");
		dir = dirname(dir);
	}
	return join(dirname(lib), "capabilities.json");
}

/** Normalize one profile file / wire payload into flags. Rules:
 *  - a boolean rides as written;
 *  - shared capabilities default ON (they are the shared grammar — a variant
 *    that could not read them is still a variant of the same services);
 *  - a PRESENT payload (the file existed) defaults hub-only capabilities to
 *    OFF — operator intent was a profile, so missing/malformed entries fail
 *    safe to "no auth code";
 *  - a MISSING payload (null) = no profile was chosen = hub/full (the
 *    single-machine dev exemption). */
export function resolveCapabilities(raw: unknown): CapabilityFlags {
	if (raw === null || raw === undefined) return hubCapabilities();
	const input =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	const bool = (k: CapabilityName, fallback: boolean): boolean => {
		const v = input[k];
		return typeof v === "boolean" ? v : fallback;
	};
	return {
		routing: bool(CAP_ROUTING, true),
		adapters: bool(CAP_ADAPTERS, true),
		aids_metering: bool(CAP_AIDS_METERING, true),
		pull_client: bool(CAP_PULL_CLIENT, true),
		auth_issuance: bool(CAP_AUTH_ISSUANCE, false),
		identity_admin: bool(CAP_IDENTITY_ADMIN, false),
		key_custody: bool(CAP_KEY_CUSTODY, false),
	};
}

// per-request reads (fleet-board, store-server) repeat stat+parse on a file
// that changes at most once per install — mtime-keyed cache, one stat per
// read (glm-5.3 review low).
const capCache = new Map<string, { mtimeMs: number; flags: CapabilityFlags }>();

/** Read the installed capabilities.json. Absent = hub (dev exemption).
 *  Present-but-unreadable = fail safe (hub-only flags OFF). Mtime-keyed
 *  cached: a file rewrite invalidates via stat, same-ms writes are not a
 *  case in practice. */
export function readCapabilities(
	file: string = capabilitiesFile(),
): CapabilityFlags {
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		// absent → hub below
	}
	const hit = capCache.get(file);
	if (hit && hit.mtimeMs === mtimeMs) return hit.flags;
	const flags = (() => {
		if (mtimeMs < 0) return hubCapabilities();
		try {
			return resolveCapabilities(JSON.parse(readFileSync(file, "utf8")));
		} catch {
			return resolveCapabilities({}); // fail safe: hub-only OFF
		}
	})();
	capCache.set(file, { mtimeMs, flags });
	return flags;
}

export function hasCapability(
	flags: CapabilityFlags,
	name: CapabilityName,
): boolean {
	return flags[name] === true;
}

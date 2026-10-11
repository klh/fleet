// src/gov/residency.ts — W235 locked residency floors
// (finding.w233-adaptation-review §2): residency+policy are LOCKED FLOORS
// in core that NO layer (env included) can loosen. The floor is the
// loosest posture any deployment can reach; operator/overlay inputs may
// only TIGHTEN (subset law, fail-closed at resolution — a loosening
// attempt throws at boot, it does not clamp). Telemetry egress defaults
// OFF: enabling is an explicit operator act, never a default. Enforcement
// is structural: candidates outside the resolved policy never become
// healthy rows (data absence — the flashx law precedent).
import { isLoopbackHost } from "../adapters/egress.ts";
import { kindOfHost } from "../candidates.ts";

/** One admitted locality class. */
export type Locality = "cloud" | "hub-local";

/** The compiled-in floor — code, not config. The LOOSEST legal posture. */
export const RESIDENCY_FLOOR: {
	regions: readonly string[];
	locality: readonly Locality[];
	telemetry: "off";
} = {
	regions: ["*"],
	locality: ["cloud", "hub-local"],
	telemetry: "off",
};

/** A resolved residency policy (always a tightening of the floor). */
export interface ResidencyPolicy {
	regions: string[];
	locality: Locality[];
	telemetry: "off" | "on";
}

const LOCALITIES: readonly Locality[] = ["cloud", "hub-local"];

/** Strict shape validation of a residency input (overlay manifest or env).
 *  Unknown localities throw — a malformed input never degrades to loose. */
export function parseResidencyInput(raw: unknown): {
	regions?: string[];
	locality?: Locality[];
	telemetry?: "off" | "on";
} {
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null)
		throw new Error("residency: input must be an object");
	const r = raw as Record<string, unknown>;
	const out: {
		regions?: string[];
		locality?: Locality[];
		telemetry?: "off" | "on";
	} = {};
	if (r["regions"] !== undefined) {
		if (
			!Array.isArray(r["regions"]) ||
			r["regions"].some((x) => typeof x !== "string")
		)
			throw new Error("residency: regions must be a string array");
		const regions = r["regions"] as string[];
		if (regions.some((x) => x.length === 0 || x.length > 64))
			throw new Error("residency: region strings must be 1..64 chars");
		out.regions = regions;
	}
	if (r["locality"] !== undefined) {
		if (
			!Array.isArray(r["locality"]) ||
			r["locality"].some((x) => !LOCALITIES.includes(x as Locality))
		)
			throw new Error(
				`residency: locality must be a subset of ${LOCALITIES.join(",")}`,
			);
		out.locality = [...new Set(r["locality"] as Locality[])];
	}
	if (r["telemetry"] !== undefined) {
		if (r["telemetry"] !== "off" && r["telemetry"] !== "on")
			throw new Error('residency: telemetry must be "off" | "on"');
		out.telemetry = r["telemetry"] as "off" | "on";
	}
	return out;
}

/** Tighten-only resolution. Inputs (operator policy / env / overlay) may
 *  only narrow the floor; anything that would widen it throws at boot. */
export function resolveResidency(inputs: {
	regions?: string[];
	locality?: Locality[];
	telemetry?: "off" | "on";
}): ResidencyPolicy {
	const locality = inputs.locality ?? [...RESIDENCY_FLOOR.locality];
	for (const l of locality) {
		if (!RESIDENCY_FLOOR.locality.includes(l))
			throw new Error(
				`residency: locality ${l} loosens the locked floor — refused`,
				);
	}
	const regions =
		inputs.regions ?? (RESIDENCY_FLOOR.regions as readonly string[]);
	if (!RESIDENCY_FLOOR.regions.includes("*")) {
		// A pinned compiled floor: inputs must stay inside it.
		if (!inputs.regions)
			throw new Error("residency: floor pins regions; input refused");
		for (const r of inputs.regions) {
			if (!RESIDENCY_FLOOR.regions.includes(r))
				throw new Error(
					`residency: region ${r} loosens the locked floor — refused`,
				);
		}
	}
	return {
		locality,
		regions: [...new Set(regions)],
		telemetry: inputs.telemetry ?? RESIDENCY_FLOOR.telemetry,
	};
}

/** Env inputs (config-over-code): BUCKLE_RESIDENCY_REGIONS=eu-central,eu-north
 *  and BUCKLE_RESIDENCY_LOCALITY=hub-local (or cloud|hub-local CSV). Empty
 * /unset = no input (floor). */
export function residencyFromEnv(env: Record<string, string | undefined>): {
	regions?: string[];
	locality?: Locality[];
	telemetry?: "off" | "on";
} {
	const csv = (v: string | undefined): string[] | undefined => {
		const parts = (v ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		return parts.length > 0 ? parts : undefined;
	};
	const regions = csv(env["BUCKLE_RESIDENCY_REGIONS"]);
	const localityRaw = csv(env["BUCKLE_RESIDENCY_LOCALITY"]);
	const locality =
		localityRaw === undefined
			? undefined
			: (localityRaw.map((l) => {
					if (!LOCALITIES.includes(l as Locality))
						throw new Error(`residency: unknown locality "${l}"`);
					return l as Locality;
				}) as Locality[]);
	return {
		regions,
		locality,
		telemetry: env["BUCKLE_RESIDENCY_TELEMETRY"] === "on" ? "on" : undefined,
	};
}

/** The group tags that carry residency claims (convention: `region:<v>`,
 *  `locality:<v>` words in the W136 tags block). */
export function residencyOfTags(tags: string[]): {
	regions: string[];
	localities: Locality[];
} {
	const regions: string[] = [];
	const localities: Locality[] = [];
	for (const t of tags) {
		if (t.startsWith("region:")) regions.push(t.slice("region:".length));
		if (t.startsWith("locality:")) {
			const v = t.slice("locality:".length) as Locality;
			if (LOCALITIES.includes(v)) localities.push(v);
		}
	}
	return { regions, localities };
}

/** Candidate admission under the resolved policy: local (loopback) hosts
 *  need `hub-local` admitted; cloud hosts need `cloud` admitted AND, when
 *  the policy pins regions, a `region:<v>` tag inside the pin (a cloud
 *  group of unknown region is denied — fail closed). */
export function residencyAllowsCandidate(input: {
	host: string;
	groupTags: string[];
	residency: ResidencyPolicy;
}): boolean {
	const isLocal = isLoopbackHost(input.host) || kindOfHost(input.host) === "local";
	const claims = residencyOfTags(input.groupTags);
	if (isLocal)
		return input.residency.locality.includes("hub-local");
	const claimsLocality = claims.localities.length > 0
		? claims.localities
		: (["cloud"] as Locality[]);
	if (!claimsLocality.every((l) => input.residency.locality.includes(l)))
		return false;
	if (input.residency.regions.includes("*")) return true;
	// pinned: a cloud candidate must PROVE its region
	return claims.regions.some((r) => input.residency.regions.includes(r));
}

// scripts/lib/belt-row-settings.ts — W2760: the installer face for the
// Belt peer row + the BUCKLE_UPSTREAMS env pins in the settings.json era.
// wireBeltRowSettings lands the authenticated belt group INSIDE
// ~/.config/klh/settings.json (`upstreams.groups.belt`) instead of the
// legacy local-llm side file; retireBuckleUpstreamsEnv drops the env pin
// so the spoke resolves settings.json directly. Same posture as
// belt-upstream-key.ts: idempotent, fail closed, 0600, never logs values.
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
	BELT_GROUP_NAME,
	BELT_ROW_URL,
	BELT_UPSTREAM_KEY_VAR,
	beltRowSpec,
} from "./belt-upstream-key.ts";

export const BUCKLE_OVERRIDE_VAR = "BUCKLE_UPSTREAMS";

export type EnsureStatus = "kept" | "wired" | "minted";

export interface EnsureResult {
	status: EnsureStatus | "failed";
	note: string;
}

const is0600 = (path: string): boolean => {
	try {
		return (statSync(path).mode & 0o777) === 0o600;
	} catch {
		return false;
	}
};

/** Lines assigning exactly `name=` (export prefix allowed). */
const assignments = (body: string, name: string): string[] =>
	body
		.split(/\r?\n/)
		.filter((l) => new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(l));

/** The belt group entry as the JSON row (settings.json
 *  `upstreams.groups.belt` — the shape loadUpstreams/mergeUpstreams read;
 *  the row NAMES the env var, the secret value never lands in the file).
 *  DRY: imported from belt-upstream-key.ts (the canonical spec). */
export { beltRowSpec };

/** True when doc.upstreams.groups.belt is exactly one authenticated row. */
export const beltRowSettingsWired = (doc: unknown): boolean => {
	const groups = ((doc as { upstreams?: { groups?: unknown } } | undefined)
		?.upstreams?.groups ?? {}) as Record<string, unknown>;
	const rows = groups[BELT_GROUP_NAME];
	if (!Array.isArray(rows) || rows.length !== 1) return false;
	const row = rows[0] as Record<string, unknown> | undefined;
	return (
		row?.url === BELT_ROW_URL &&
		row?.dialect === "anthropic" &&
		row?.api_key_env === BELT_UPSTREAM_KEY_VAR
	);
};

/** The W2760 law-home write: ensure settings.json carries the belt row.
 *  Idempotent (a matching row = kept), creates the file 0600 when absent,
 *  fails closed on unparseable/non-object bytes — never guesses over
 *  operator content. */
export function wireBeltRowSettings(settingsPath: string): EnsureResult {
	let body = "";
	try {
		body = readFileSync(settingsPath, "utf8");
	} catch {
		body = ""; // absent file → seed settings.json with the row
	}
	let doc: Record<string, unknown>;
	if (body.trim() === "") doc = {};
	else {
		try {
			const parsed: unknown = JSON.parse(body);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return {
					status: "failed",
					note: `${settingsPath} is not a JSON object — Belt-row wiring refused`,
				};
			doc = parsed as Record<string, unknown>;
		} catch {
			return {
				status: "failed",
				note: `${settingsPath} does not parse as JSON — Belt-row wiring refused`,
			};
		}
	}
	if (beltRowSettingsWired(doc))
		return { status: "kept", note: `belt row kept in ${settingsPath}` };
	const upstreams = {
		...(doc.upstreams as Record<string, unknown> | undefined),
	} as Record<string, unknown>;
	upstreams.groups = {
		...(upstreams.groups as Record<string, unknown> | undefined),
		[BELT_GROUP_NAME]: [beltRowSpec()],
	};
	doc.upstreams = upstreams;
	writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`, {
		mode: 0o600,
	});
	if (!is0600(settingsPath)) chmodSync(settingsPath, 0o600);
	return {
		status: "wired",
		note: `belt row wired (api_key_env ${BELT_UPSTREAM_KEY_VAR}) in ${settingsPath}`,
	};
}

/** W2760 retire: drop the BUCKLE_UPSTREAMS assignment from an env file —
 *  the spoke resolves settings.json directly now; a lingering pin would
 *  shadow it (a pin always wins). Idempotent; 0600 preserved. */
export function retireBuckleUpstreamsEnv(envPath: string): EnsureResult {
	let body: string;
	try {
		body = readFileSync(envPath, "utf8");
	} catch {
		return { status: "kept", note: `${envPath} absent — nothing to retire` };
	}
	const hits = assignments(body, BUCKLE_OVERRIDE_VAR);
	if (hits.length === 0)
		return { status: "kept", note: `${BUCKLE_OVERRIDE_VAR} already absent` };
	if (hits.length > 1)
		return {
			status: "failed",
			note: `${BUCKLE_OVERRIDE_VAR} assigned more than once in ${envPath} — fix the file`,
		};
	const kept = body
		.split(/\r?\n/)
		.filter((l) => assignments(l, BUCKLE_OVERRIDE_VAR).length === 0);
	writeFileSync(envPath, kept.join("\n").replace(/\n*$/, "\n"), {
		mode: 0o600,
	});
	if (!is0600(envPath)) chmodSync(envPath, 0o600);
	return {
		status: "wired",
		note: `${BUCKLE_OVERRIDE_VAR} retired from ${envPath} (W2760: settings.json owns the chain)`,
	};
}

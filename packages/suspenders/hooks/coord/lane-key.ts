// hooks/coord/lane-key.ts — W2885: lane-key lifecycle as a CLI verb (fleet
// consult C313). Agents minting scoped bksk_ keys by hand were rolling
// curl+root-key+python-parsing pipes that leak secrets through /tmp and
// shell history; this is thin wiring over the canonical mint/revoke/list
// in lib/lanes/lane-auth.ts — the root key never leaves this process (no
// env fallback: resolved per-hub via hubCredential's token_file chain) and
// the mint path prints only the key id, never the key material.
import { resolve } from "node:path";
import { hubBuckleUrl } from "../lib/hub/hub-endpoint.ts";
import { profileForLabel } from "../lib/hub/hub-locate.ts";
import { writeJsonConf } from "../lib/kernel-conf.ts";
import {
	hubCredential,
	listLaneKeys,
	mintLaneKey,
	revokeLaneKey,
} from "../lib/lanes/lane-auth.ts";
import {
	defineVerb,
	dispatchSub,
	type Parsed,
	type VerbSpec,
} from "../lib/verb-kit.ts";

const DEFAULT_HUB = "desktop";
const DEFAULT_SCOPE = "buckle:proxy:WRITE_";

/** The hub's buckle URL — synchronous, no liveness probe (the mint/revoke/
 *  list fetch itself times out and fails closed on an unreachable front;
 *  a probe here would just pay the same timeout twice). */
const frontFor = (hub: string): string | null => {
	const prof = profileForLabel(hub);
	return prof ? hubBuckleUrl(prof) : null;
};

/** Resolve the (front, admin) pair every sub-verb needs, or throw with the
 *  exact fail-closed reason — never a partial credential half-used. */
const hubRung = (hub: string): { front: string; admin: string } => {
	const front = frontFor(hub);
	if (!front)
		throw new Error(
			`no buckle front for hub "${hub}" (settings.json hubs.${hub})`,
		);
	const admin = hubCredential(hub);
	if (!admin)
		throw new Error(
			`no credential for hub "${hub}" (hubCredential — env/registry/profile token_file)`,
		);
	return { front, admin };
};

async function runMintFile(p: Parsed): Promise<number> {
	const [name, path] = p.pos;
	const { front, admin } = hubRung(p.flag("--hub") ?? DEFAULT_HUB);
	const ttlRaw = p.flag("--ttl");
	const ttlS = ttlRaw != null ? Number(ttlRaw) : undefined;
	if (ttlRaw != null && (!Number.isFinite(ttlS) || (ttlS ?? 0) <= 0))
		throw new Error(
			`--ttl must be a positive number of seconds, got "${ttlRaw}"`,
		);
	const scopeRaw = p.flag("--scope");
	const scopes = scopeRaw
		? scopeRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [DEFAULT_SCOPE];
	const minted = await mintLaneKey(name ?? "", admin, fetch, front, {
		scopes,
		ttlS,
	});
	if (!minted)
		throw new Error(
			"mint refused (bad scopes, admin credential, or unreachable front)",
		);
	try {
		writeJsonConf(resolve(path ?? ""), {
			name,
			front,
			key_id: minted.keyId,
			key: minted.key,
			scopes: minted.scopes ?? scopes,
			expires_at: minted.expiresAt ?? null,
			minted_at: Date.now(),
		});
	} catch (e) {
		// local write failed after a live mint — revoke rather than leave an
		// orphaned key with no local record of its id (fail closed, W2885)
		await revokeLaneKey(minted.keyId, admin, fetch, front).catch(() => {});
		throw e;
	}
	console.log(minted.keyId);
	return 0;
}

async function runRevoke(p: Parsed): Promise<number> {
	const [id] = p.pos;
	const { front, admin } = hubRung(p.flag("--hub") ?? DEFAULT_HUB);
	const revoked = await revokeLaneKey(id ?? "", admin, fetch, front);
	console.log(JSON.stringify({ key_id: id, revoked }));
	return revoked ? 0 : 1;
}

async function runList(p: Parsed): Promise<number> {
	const { front, admin } = hubRung(p.flag("--hub") ?? DEFAULT_HUB);
	const rows = await listLaneKeys(admin, fetch, front);
	if (!rows)
		throw new Error("list refused (admin credential or unreachable front)");
	if (p.flag("--json") === "true") {
		console.log(JSON.stringify(rows, null, 2));
		return 0;
	}
	if (!rows.length) {
		console.log("no keys");
		return 0;
	}
	for (const r of rows) {
		const status = r.revokedAt
			? "revoked"
			: r.expiresAt && r.expiresAt <= Date.now()
				? "expired"
				: "active";
		console.log(
			`${r.keyId}  ${r.name}  [${r.scopes.join(",")}]  expires=${r.expiresAt ?? "never"}  ${status}`,
		);
	}
	return 0;
}

export const LANE_KEY_VERBS: VerbSpec[] = [
	defineVerb({
		name: "mint-file",
		usage:
			"usage: lane-key mint-file <name> <path> [--ttl S] [--scope s1,s2] [--hub h]",
		help: "mint a scoped lane key, write it 0600 atomic to <path>, print the key id only",
		flags: ["--ttl", "--scope", "--hub"],
		minPos: 2,
		run: runMintFile,
	}),
	defineVerb({
		name: "revoke",
		usage: "usage: lane-key revoke <id> [--hub h]",
		help: "revoke a minted lane key by id, print the revocation receipt",
		flags: ["--hub"],
		minPos: 1,
		run: runRevoke,
	}),
	defineVerb({
		name: "list",
		usage: "usage: lane-key list [--hub h] [--json]",
		help: "list minted lane keys (id/name/scopes/expiry, no secrets)",
		flags: ["--hub"],
		switches: ["--json"],
		run: runList,
	}),
];

export async function cmdLaneKey(rest: string[]): Promise<number> {
	return dispatchSub("lane-key", "coord lane-key —", LANE_KEY_VERBS, rest);
}

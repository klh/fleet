// hooks/lib/capacity/ramp-manifest.ts — W1713 the run's revocation manifest:
// key IDS ONLY (never a token), 0600, rewritten before each key is used so a
// crashed run still leaves everything `capacity-ramp cleanup` needs. Cleanup
// is idempotent and verified against the gateway's key list.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ManifestKey {
	sid: string;
	keyId: string;
}

export interface Manifest {
	runId: string;
	front: string;
	createdMs: number;
	keys: ManifestKey[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export function writeManifest(path: string, m: Manifest): void {
	writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

export function readManifest(path: string): Manifest | null {
	if (!existsSync(path)) return null;
	let j: unknown;
	try {
		j = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (!isRecord(j) || !Array.isArray(j.keys)) return null;
	const keys: ManifestKey[] = [];
	for (const k of j.keys)
		if (isRecord(k) && typeof k.sid === "string" && typeof k.keyId === "string")
			keys.push({ sid: k.sid, keyId: k.keyId });
	return {
		runId: typeof j.runId === "string" ? j.runId : "",
		front: typeof j.front === "string" ? j.front : "",
		createdMs: typeof j.createdMs === "number" ? j.createdMs : 0,
		keys,
	};
}

export interface CleanupResult {
	total: number;
	revoked: number;
	failed: string[];
	/** the gateway's key list agrees every manifest key is revoked; null = list unreadable */
	verified: boolean | null;
}

export async function cleanupManifest(
	m: Manifest,
	io: {
		revoke: (keyId: string) => Promise<boolean>;
		revocations: (ids: string[]) => Promise<Map<string, boolean> | null>;
	},
): Promise<CleanupResult> {
	const failed: string[] = [];
	for (const k of m.keys)
		if (!((await io.revoke(k.keyId)) || (await io.revoke(k.keyId))))
			failed.push(k.keyId);
	const ids = m.keys.map((k) => k.keyId);
	const state = await io.revocations(ids);
	const verified =
		state === null ? null : ids.every((id) => state.get(id) !== false);
	return {
		total: ids.length,
		revoked: ids.length - failed.length,
		failed,
		verified,
	};
}

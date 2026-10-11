// src/gov/overlay-loader.ts — W235 signed/allowlisted overlay loading
// (finding.w233-adaptation-review §4): KLH_OVERLAY_DIR is a code-loader
// hole unless the path is allowlisted (root-owned dirs only), the entry
// module's digest is pinned (manifest sha256 + operator pin), and the
// overlay's protocol version handshakes with core (fail-closed — a
// mismatch refuses the load). Refusals are FATAL at boot when
// KLH_OVERLAY_DIR is set; unset = solo posture (not an error). Every load
// logs what loaded (name, protocol, entry digest) — log-at-startup law.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { OVERLAY_PROTOCOL_VERSION, validateAdaptation } from "./adaptation.ts";
import type { AdaptationConfig } from "./adaptation.ts";
import { validatePeerEndpoint } from "../adapters/egress.ts";

/** Validated overlay manifest (manifest.json in the overlay dir). */
export interface OverlayManifest {
	/** Overlay name — startup-log only. */
	name: string;
	/** Fail-closed version handshake against OVERLAY_PROTOCOL_VERSION. */
	protocol: number;
	/** Entry module path, RELATIVE to the overlay dir (no .., not absolute). */
	entry: string;
	/** Hex sha256 of the entry file — refuse-on-mismatch. */
	sha256: string;
	/** Hosts the overlay contacts (unit 5 egress allowlist input). */
	endpoints?: string[];
}

/** Production allowlist: root-owned dirs only. */
export const DEFAULT_OVERLAY_ALLOW_ROOTS: readonly string[] = [
	"/etc/klh/overlays",
	"/usr/local/lib/klh/overlays",
];

const SHA_RE = /^[0-9a-f]{64}$/;
const NAME_MAX = 64;

/** Parse + strictly validate a manifest object (shape law). */
export function parseOverlayManifest(raw: unknown): OverlayManifest {
	if (typeof raw !== "object" || raw === null)
		throw new Error("overlay: manifest must be an object");
	const r = raw as Record<string, unknown>;
	const name = r["name"];
	if (typeof name !== "string" || name.length === 0 || name.length > NAME_MAX)
		throw new Error("overlay: manifest.name must be 1..64 chars");
	const protocol = r["protocol"];
	if (typeof protocol !== "number" || !Number.isInteger(protocol))
		throw new Error("overlay: manifest.protocol must be an integer");
	const entry = r["entry"];
	if (
		typeof entry !== "string" ||
		entry.length === 0 ||
		isAbsolute(entry) ||
		entry.includes("..")
	)
		throw new Error("overlay: manifest.entry must be a relative path");
	const sha = r["sha256"];
	if (typeof sha !== "string" || !SHA_RE.test(sha))
		throw new Error("overlay: manifest.sha256 must be 64 hex chars");
	const endpoints = r["endpoints"];
	if (
		endpoints !== undefined &&
		(!Array.isArray(endpoints) ||
			endpoints.some((e) => typeof e !== "string" || e.length === 0))
	)
		throw new Error("overlay: manifest.endpoints must be string array");
	return {
		name,
		protocol,
		entry,
		sha256: sha,
		...(Array.isArray(endpoints) ? { endpoints: endpoints as string[] } : {}),
	} satisfies OverlayManifest;
}

/** Allowlist check: the overlay dir (after symlink resolution) must live
 *  under one of the allowed roots; a missing allow-root is skipped. */
export async function overlayDirAllowed(
	dir: string,
	allowRoots: readonly string[],
): Promise<boolean> {
	let real: string;
	try {
		real = await realpath(dir);
	} catch {
		return false;
	}
	for (const root of allowRoots) {
		try {
			const realRoot = await realpath(root);
			if (real === realRoot || real.startsWith(realRoot + "/")) return true;
		} catch {
			// a missing allow-root is skipped, not fatal
		}
	}
	return false;
}

export type OverlayLoad =
	| { ok: true; manifest: OverlayManifest; module: unknown }
	| { ok: false; why: string };

/** KLH_OVERLAY_ALLOW: operator roots, colon-separated (config-over-code). */
export function envRoots(): string[] {
	const raw = process.env["KLH_OVERLAY_ALLOW"] ?? "";
	return raw
		.split(":")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** file:// URL for the dynamic import (anchored at an absolute path). */
export function pathToFileUrl(p: string): string {
	return `file://${p.startsWith("/") ? "" : "/"}${p}`;
}

/** Extract the adaptation surface from a loaded overlay module — the
 *  contract the CI fixture and the enterprise overlay both implement.
 *  Present-but-malformed throws (fail closed at boot). */
export function overlayModuleAdaptation(
	mod: unknown,
): AdaptationConfig | undefined {
	const m = mod as { createAdaptation?: unknown } | null;
	if (m?.createAdaptation === undefined) return undefined;
	if (typeof m.createAdaptation !== "function")
		throw new Error("overlay: createAdaptation must be a function");
	return validateAdaptation(m.createAdaptation() as AdaptationConfig);
}

/** Load the overlay at `dir` under the allowlist + digest + handshake laws.
 *  dir === undefined → { ok:false, why:"unset" } — the solo state. */
export async function loadOverlay(opts: {
	dir: string | undefined;
	allowRoots?: readonly string[];
	expectSha256?: string;
}): Promise<OverlayLoad> {
	if (opts.dir === undefined || opts.dir.length === 0)
		return { ok: false, why: "unset" };
	const { dir } = opts;
	try {
		const allowRoots = [
			...(opts.allowRoots ?? DEFAULT_OVERLAY_ALLOW_ROOTS),
			...envRoots(),
		];
		if (!(await overlayDirAllowed(dir, allowRoots)))
			return { ok: false, why: `path not allowlisted: ${dir}` };
		const manifest = parseOverlayManifest(
			JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")),
		);
		if (manifest.protocol !== OVERLAY_PROTOCOL_VERSION)
			return {
				ok: false,
				why: `protocol handshake failed: overlay ${String(manifest.protocol)} vs core ${String(OVERLAY_PROTOCOL_VERSION)}`,
			};
		// W235 §5 egress law: overlay-declared endpoints pass the peer
		// allowlist BEFORE anything loads — a dropped peer file never
		// gains egress by default.
		for (const ep of manifest.endpoints ?? []) {
			try {
				validatePeerEndpoint(ep);
			} catch (e) {
				return {
					ok: false,
					why: `peer endpoint refused: ${e instanceof Error ? e.message : String(e)}`,
				};
			}
		}
		const entryPath = join(dir, manifest.entry);
		const st = await stat(entryPath);
		if (!st.isFile()) return { ok: false, why: "entry is not a file" };
		const body = await readFile(entryPath);
		const digest = createHash("sha256").update(body).digest("hex");
		if (digest !== manifest.sha256)
			return {
				ok: false,
				why: `entry digest mismatch: file ${digest} vs manifest ${manifest.sha256} — refuse`,
			};
		if (opts.expectSha256 !== undefined && opts.expectSha256 !== digest)
			return {
				ok: false,
				why: `operator pin mismatch: file ${digest} vs KLH_OVERLAY_SHA256 — refuse`,
			};
		const mod = await import(pathToFileUrl(entryPath));
		return { ok: true, manifest, module: mod };
	} catch (e) {
		return { ok: false, why: e instanceof Error ? e.message : String(e) };
	}
}

// deploy/sbom.ts — W698: CycloneDX 1.5 SBOM + third-party license notice,
// derived from the committed bun.lock (the same bytes `bun install
// --frozen-lockfile` honors) and the digest-pinned images in
// hub-compose.yaml. Pure functions: no clock, no network, deterministic —
// the same lock + compose always yield byte-identical output, so the SBOM
// digest recorded in the release manifest is reproducible.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LockPackage {
	name: string;
	version: string;
	/** "workspace" = this monorepo's own package (no registry artifact). */
	source: "registry" | "workspace" | "other";
	/** sha512 integrity as lowercase hex, when the lock carries one. */
	sha512?: string;
	deps: string[];
}

export interface ImagePin {
	/** repository, e.g. oven/bun:1 */
	ref: string;
	/** sha256:<hex>, or null when the reference is not digest-pinned. */
	digest: string | null;
}

export interface Component {
	type: "library" | "container" | "application";
	"bom-ref": string;
	name: string;
	version: string;
	purl?: string;
	hashes?: Array<{ alg: string; content: string }>;
	licenses?: Array<{ license: { name: string } } | { expression: string }>;
}

const purlName = (name: string): string =>
	name.startsWith("@") ? `%40${name.slice(1)}` : name;

/** `sha512-<base64>` → lowercase hex (CycloneDX hash content). */
function integrityHex(integrity: unknown): string | undefined {
	if (typeof integrity !== "string") return undefined;
	const m = /^sha512-(.+)$/.exec(integrity);
	return m ? Buffer.from(m[1], "base64").toString("hex") : undefined;
}

/** Parse bun.lock (JSONC: trailing commas) into flat package rows. Entry
 *  shape: key → [ident@version, registry, {dependencies…}, integrity]. */
export function parseBunLock(text: string): LockPackage[] {
	const lock = Bun.JSONC.parse(text) as {
		packages?: Record<string, unknown[]>;
	};
	const rows: LockPackage[] = [];
	for (const entry of Object.values(lock.packages ?? {})) {
		const ident = String(entry[0] ?? "");
		const at = ident.lastIndexOf("@");
		if (at <= 0) continue;
		const name = ident.slice(0, at);
		const version = ident.slice(at + 1);
		const meta = (entry[2] ?? {}) as Record<string, Record<string, string>>;
		const deps = Object.keys({
			...meta.dependencies,
			...meta.optionalDependencies,
		});
		const workspace = version.startsWith("workspace:");
		rows.push({
			name,
			version,
			source: workspace
				? "workspace"
				: typeof entry[3] === "string"
					? "registry"
					: "other",
			sha512: integrityHex(entry[3]),
			deps,
		});
	}
	return rows.sort((a, b) =>
		`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
	);
}

/** Every `image: repo@sha256:…` (or unpinned) reference in a compose file. */
export function parseImagePins(composeText: string): ImagePin[] {
	const seen = new Map<string, ImagePin>();
	for (const m of composeText.matchAll(/^\s+image:\s*(\S+)\s*$/gm)) {
		const full = m[1];
		if (full.startsWith("*")) continue; // yaml alias of an already-listed ref
		const [ref, digest] = full.split("@");
		const pin = { ref, digest: digest ?? null };
		seen.set(full, pin);
	}
	return [...seen.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

/** SPDX/name from an installed package.json (null when node_modules lacks it). */
function licenseOf(root: string, name: string): string | null {
	const file = join(root, "node_modules", name, "package.json");
	if (!existsSync(file)) return null;
	try {
		const j = JSON.parse(readFileSync(file, "utf8")) as {
			license?: string | { type?: string };
		};
		return typeof j.license === "string" ? j.license : (j.license?.type ?? null);
	} catch {
		return null;
	}
}

export function buildComponents(
	pkgs: LockPackage[],
	images: ImagePin[],
	root: string,
): Component[] {
	const out: Component[] = [];
	for (const p of pkgs) {
		const purl = `pkg:npm/${purlName(p.name)}@${p.version}`;
		const lic = p.source === "workspace" ? null : licenseOf(root, p.name);
		out.push({
			type: p.source === "workspace" ? "application" : "library",
			"bom-ref": purl,
			name: p.name,
			version: p.version,
			...(p.source === "workspace" ? {} : { purl }),
			...(p.sha512 ? { hashes: [{ alg: "SHA-512", content: p.sha512 }] } : {}),
			...(lic ? { licenses: [{ license: { name: lic } }] } : {}),
		});
	}
	for (const i of images) {
		const hex = i.digest?.replace(/^sha256:/, "");
		out.push({
			type: "container",
			"bom-ref": `image:${i.ref}@${i.digest ?? "unpinned"}`,
			name: i.ref,
			version: i.digest ?? "unpinned",
			...(hex ? { hashes: [{ alg: "SHA-256", content: hex }] } : {}),
		});
	}
	return out;
}

export function buildSbom(
	components: Component[],
	pkgs: LockPackage[],
	rootName: string,
	rootVersion: string,
): Record<string, unknown> {
	const refOf = new Map(
		pkgs.map((p) => [p.name, `pkg:npm/${purlName(p.name)}@${p.version}`]),
	);
	const dependencies = pkgs.map((p) => ({
		ref: refOf.get(p.name) ?? p.name,
		dependsOn: p.deps.map((d) => refOf.get(d)).filter(Boolean),
	}));
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		version: 1,
		metadata: {
			component: {
				type: "application",
				"bom-ref": rootName,
				name: rootName,
				version: rootVersion,
			},
			tools: { components: [{ type: "application", name: "fleet-sbom" }] },
		},
		components,
		dependencies,
	};
}

/** Plain-text license notice: one line per third-party component. */
export function buildNotices(components: Component[]): string {
	const lines = ["THIRD-PARTY NOTICES (generated from bun.lock)", ""];
	for (const c of components) {
		if (c.type !== "library") continue;
		const l = c.licenses?.[0];
		const lic =
			l && "license" in l ? l.license.name : "NOASSERTION (not installed)";
		lines.push(`${c.name}@${c.version}  ${lic}`);
	}
	return `${lines.join("\n")}\n`;
}

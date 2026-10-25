// deploy/release-manifest.ts — W698: the ONE release manifest. Pins, for a
// fleet checkout: the fleet sha, the bun.lock digest, every container-image
// digest the hub compose pulls, the schema versions the migration ladders
// produce (governor.db / knowledge.db — probed by opening FRESH databases
// under a throwaway HOME, so the real ladder answers, never a copied
// constant), and sha256 checksums of the shipped artifacts + the SBOM and
// license notice derived from them. Deterministic: no clock, same inputs →
// same bytes (the SBOM digest the manifest records is reproducible).
//   bun deploy/release-manifest.ts [--out <dir>] [--pinned <ref>]
//     writes release-manifest.json, sbom.cdx.json, THIRD-PARTY-NOTICES.txt
//     to <dir> (default: stdout manifest only); --pinned records the stack
//     version a hub deploys and whether it equals the checkout sha.
//   bun deploy/release-manifest.ts --probe-schema   # internal: HOME-scoped
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeFacts } from "./runtime-info.ts";
import {
	buildComponents,
	buildNotices,
	buildSbom,
	parseBunLock,
	parseImagePins,
} from "./sbom.ts";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../../..");
const COMPOSE = join(HERE, "hub-compose.yaml");
const LOCK = join(ROOT, "bun.lock");

export const MANIFEST_SCHEMA = "fleet.release-manifest.v1";

export const sha256 = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

export interface SchemaVersions {
	governor: number;
	knowledge: number;
}

/** Child-side: open fresh DBs under the (temp) HOME and report user_version. */
async function probeSchema(): Promise<SchemaVersions> {
	const g = await import("../hooks/lib/govdb/govdb.ts");
	const version = (db: ReturnType<typeof g.openGovernorDb>): number =>
		(db.query("PRAGMA user_version").get() as { user_version: number })
			.user_version;
	const gov = g.openGovernorDb();
	const kn = g.openKnowledgeDb();
	const out = { governor: version(gov), knowledge: version(kn) };
	gov.close();
	kn.close();
	return out;
}

/** The migration ladder's tip, from a fresh DB in a throwaway HOME. */
export function schemaVersions(): SchemaVersions {
	const home = mkdtempSync(join(tmpdir(), "fleet-manifest-"));
	try {
		const out = execFileSync(
			process.execPath,
			[import.meta.path, "--probe-schema"],
			{ encoding: "utf8", env: { ...process.env, HOME: home } },
		);
		return JSON.parse(out.trim().split("\n").at(-1) ?? "") as SchemaVersions;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

export interface ManifestInput {
	sha: string;
	pinned?: string;
	schema: SchemaVersions;
}

export interface Release {
	manifest: Record<string, unknown>;
	sbom: string;
	notices: string;
}

/** Assemble manifest + SBOM + notices (pure over its inputs + the files). */
export function buildRelease(input: ManifestInput): Release {
	const lockText = readFileSync(LOCK, "utf8");
	const composeText = readFileSync(COMPOSE, "utf8");
	const pkgs = parseBunLock(lockText);
	const images = parseImagePins(composeText);
	const components = buildComponents(pkgs, images, ROOT);
	const sbom = `${JSON.stringify(buildSbom(components, pkgs, "fleet", input.sha), null, 2)}\n`;
	const notices = buildNotices(components);
	const rt = runtimeFacts();
	const manifest = {
		schema: MANIFEST_SCHEMA,
		fleet: {
			sha: input.sha,
			...(input.pinned
				? { pinned: input.pinned, pinnedMatchesSha: input.pinned === input.sha }
				: {}),
		},
		lock: { file: "bun.lock", sha256: sha256(lockText), packages: pkgs.length },
		runtime: {
			emitter: { bun: rt.bun, sqlite: rt.sqlite },
			images: images.map((i) => ({ ref: i.ref, digest: i.digest })),
			unpinnedImages: images.filter((i) => !i.digest).map((i) => i.ref),
		},
		schemaVersions: input.schema,
		checksums: {
			"deploy/hub-compose.yaml": sha256(composeText),
			"bun.lock": sha256(lockText),
			"sbom.cdx.json": sha256(sbom),
			"THIRD-PARTY-NOTICES.txt": sha256(notices),
		},
	};
	return { manifest, sbom, notices };
}

export function writeRelease(r: Release, outDir: string): void {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, "release-manifest.json"),
		`${JSON.stringify(r.manifest, null, 2)}\n`,
	);
	writeFileSync(join(outDir, "sbom.cdx.json"), r.sbom);
	writeFileSync(join(outDir, "THIRD-PARTY-NOTICES.txt"), r.notices);
}

/** The checkout's own sha (git rev-parse HEAD). */
export const checkoutSha = (): string =>
	execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--probe-schema")) {
		console.log(JSON.stringify(await probeSchema()));
		return;
	}
	const flag = (n: string): string | undefined => {
		const i = args.indexOf(n);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const r = buildRelease({
		sha: checkoutSha(),
		pinned: flag("--pinned"),
		schema: schemaVersions(),
	});
	const out = flag("--out");
	if (out) writeRelease(r, out);
	else console.log(JSON.stringify(r.manifest, null, 2));
}

if (import.meta.main) await main();

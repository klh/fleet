// litellm-integrity.ts — LiteLLM supply-chain integrity audit (W1197).
// 2026-10-22 report: litellm 1.107.0 shipped a credential stealer on PyPI
// for a ~2h window; the release is since deindexed. This audit proves the
// uv-tool install matches the PyPI-published artifacts hash-for-hash:
// wheel sha256 == published digest, wheel RECORD == installed RECORD, and
// every installed file == its RECORD entry. Banks a receipt carrying the
// version, install date and hash evidence. Verify-and-report only — it
// never auto-repairs.
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LITELLM_TOOL_SPEC } from "./litellm-target.ts";

/** Version-level compromise trigger (W1197): PyPI deindexed 1.107.0
 * (verified 2026-10-23), so no clean copy can be proven — ANY installed
 * 1.107.0 counts as exposure and demands key rotation. */
export const COMPROMISED_LITELLM_VERSIONS: readonly string[] = ["1.107.0"];
export const PYPI_JSON_API = "https://pypi.org/pypi";
export const INTEGRITY_TIMEOUT_MS = 120_000;

/** The pinned uv tool env (litellmToolInstallArgs pins --python 3.13). */
export const litellmSitePackages = (home = process.env.HOME ?? ""): string =>
	`${home}/.local/share/uv/tools/litellm/lib/python3.13/site-packages`;

export interface PypiArtifact {
	filename: string;
	sha256: string;
	url: string;
	yanked: boolean;
	size: number;
}

export interface DistAudit {
	dist: string;
	project: string;
	version: string;
	/** dist-info birthtime (install moment), ISO or null when unstattable. */
	installDate: string | null;
	/** The PyPI wheel whose digest was checked (null = none selectable). */
	wheel: string | null;
	wheelDigestMatch: boolean | null;
	recordFiles: number;
	recordVerified: boolean | null;
	/** Chain strength: wheel-digest+record > record-only > unverified. */
	provenance:
		| "wheel-digest+record"
		| "record-only"
		| "absent-from-pypi"
		| "error";
	error?: string;
}

export interface IntegrityAudit {
	auditedAt: string;
	spec: string;
	sitePackages: string;
	dists: DistAudit[];
	/** Installed litellm core version (the compromise trigger input). */
	litellmVersion: string | null;
	compromisedVersions: readonly string[];
	verdict: "clean" | "exposed" | "unverifiable";
	reason: string;
}

/** PEP 503 normalization: dist-info name → PyPI project name. */
export const pypiProjectName = (dist: string): string =>
	dist.toLowerCase().replace(/[-_.]+/g, "-");

/** base64url (RECORD alphabet, unpadded) → lowercase hex digest. */
export const b64urlToHex = (b64url: string): string =>
	Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
		c.charCodeAt(0).toString(16).padStart(2, "0"),
	).join("");

/** Streaming sha256 — wheels and site trees never fully buffer. */
export const sha256File = async (path: string): Promise<string> => {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
	return hash.digest("hex");
};

export interface RecordRow {
	path: string;
	sha256: string | null;
}

/** CSV RECORD rows: `path,sha256=<b64url>,size`. Hash-less rows (the
 *  RECORD itself, some data files) verify nothing. */
export const parseRecord = (text: string): RecordRow[] =>
	text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const [path, hashColumn] = line.split(",");
			const match = /^sha256=(.+)$/.exec(hashColumn ?? "");
			return { path, sha256: match ? match[1] : null };
		});

/** All litellm-family dists in the tool env (core + proxy_extras +
 *  enterprise — anything the pinned install pulled). */
export const distInfoDirs = (sitePackages: string): string[] =>
	readdirSync(sitePackages)
		.filter((entry) => entry.endsWith(".dist-info"))
		.filter((entry) =>
			pypiProjectName(entry.split("-")[0]).startsWith("litellm"),
		)
		.sort();

/** Name/Version from dist-info METADATA (source of truth over dirname). */
export const readDistMeta = (
	distInfoPath: string,
): { name: string; version: string } => {
	const meta = readFileSync(join(distInfoPath, "METADATA"), "utf8");
	const name = /^Name: (.+)$/m.exec(meta)?.[1] ?? "";
	const version = /^Version: (.+)$/m.exec(meta)?.[1] ?? "";
	return { name, version };
};

export interface RecordCheck {
	files: number;
	verified: boolean | null;
	mismatches: string[];
}

/** Hash every hash-bearing RECORD file in the installed tree. */
export const verifyRecord = async (
	sitePackages: string,
	distInfoDir: string,
): Promise<RecordCheck> => {
	const rows = parseRecord(
		readFileSync(join(sitePackages, distInfoDir, "RECORD"), "utf8"),
	);
	const mismatches: string[] = [];
	let files = 0;
	for (const row of rows) {
		if (!row.sha256) continue;
		files += 1;
		let actual: string | null = null;
		try {
			actual = await sha256File(join(sitePackages, row.path));
		} catch {
			actual = null;
		}
		if (actual !== b64urlToHex(row.sha256)) mismatches.push(row.path);
	}
	return {
		files,
		verified: files > 0 ? mismatches.length === 0 : null,
		mismatches: mismatches.slice(0, 10),
	};
};

/** Published artifacts for one release; throws when the version is absent
 *  from the index (deindexed releases fail integrity, never pass). */
export const fetchPypiArtifacts = async (
	project: string,
	version: string,
	fetcher: typeof fetch = fetch,
): Promise<PypiArtifact[]> => {
	const res = await fetcher(`${PYPI_JSON_API}/${project}/${version}/json`, {
		signal: AbortSignal.timeout(INTEGRITY_TIMEOUT_MS),
	});
	if (res.status === 404)
		throw new Error(`${project} ${version} is absent from the PyPI index`);
	if (!res.ok)
		throw new Error(`PyPI query for ${project} ${version}: HTTP ${res.status}`);
	const body = (await res.json()) as { urls?: Array<Record<string, unknown>> };
	return (body.urls ?? []).map((u) => ({
		filename: String(u.filename ?? ""),
		sha256: String(
			(u.digests as { sha256?: string } | undefined)?.sha256 ?? "",
		),
		url: String(u.url ?? ""),
		yanked: Boolean(u.yanked),
		size: Number(u.size ?? 0),
	}));
};

/** This machine's wheel, else any macosx arm64 wheel, else any wheel. */
export const pickWheel = (artifacts: PypiArtifact[]): PypiArtifact | null => {
	const wheels = artifacts.filter((a) => a.filename.endsWith(".whl"));
	const arm64 = wheels.filter((w) => w.filename.includes("macosx_11_0_arm64"));
	const abi3 = arm64.filter((w) => w.filename.includes("cp310-abi3"));
	return abi3[0] ?? arm64[0] ?? wheels[0] ?? null;
};

export interface AuditDeps {
	sitePackages?: string;
	fetcher?: typeof fetch;
	/** Streams one PyPI URL to a local path (tests stub this). */
	downloader?: (url: string, dest: string) => Promise<void>;
	/** Extracts one inner file's text from the downloaded wheel. */
	unzipper?: (wheel: string, innerPath: string) => string;
	cacheDir?: string;
	now?: () => Date;
}

const defaultDownloader = async (url: string, dest: string): Promise<void> => {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(INTEGRITY_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`wheel download HTTP ${res.status}`);
	await Bun.write(dest, res);
};

const defaultUnzipper = (wheel: string, innerPath: string): string => {
	const proc = Bun.spawnSync(["unzip", "-p", wheel, innerPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0)
		throw new Error(
			`unzip ${innerPath}: ${proc.stderr.toString().slice(0, 200)}`,
		);
	return proc.stdout.toString();
};

const installDate = (distInfoPath: string): string | null => {
	try {
		const stat = statSync(distInfoPath);
		const ms = stat.birthtimeMs || stat.mtimeMs;
		return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
	} catch {
		return null;
	}
};

/** path→sha256 for the hash-bearing rows of a wheel's RECORD. */
export const recordMap = (text: string): Map<string, string> => {
	const map = new Map<string, string>();
	for (const row of parseRecord(text)) {
		if (row.sha256) map.set(row.path, row.sha256);
	}
	return map;
};

/** Every published wheel row is installed byte-identical. Installers
 *  append their own dist-info rows (INSTALLER, direct_url.json) beyond the
 *  wheel's RECORD, so equality is wrong; a substituted file can never stay
 *  covered — its hash would differ or the row would go missing. */
export const wheelRecordCovered = (
	wheel: Map<string, string>,
	installed: Map<string, string>,
): boolean => {
	for (const [path, hash] of wheel) {
		if (installed.get(path) !== hash) return false;
	}
	return true;
};

/** Audit one installed dist against its PyPI release. */
export const auditOneDist = async (
	distInfoDir: string,
	deps: AuditDeps,
): Promise<DistAudit> => {
	const sitePackages = deps.sitePackages ?? litellmSitePackages();
	const distInfoPath = join(sitePackages, distInfoDir);
	const { name, version } = readDistMeta(distInfoPath);
	const base: DistAudit = {
		dist: name,
		project: pypiProjectName(name),
		version,
		installDate: installDate(distInfoPath),
		wheel: null,
		wheelDigestMatch: null,
		recordFiles: 0,
		recordVerified: null,
		provenance: "error",
	};
	let artifacts: PypiArtifact[];
	try {
		artifacts = await fetchPypiArtifacts(
			base.project,
			version,
			deps.fetcher ?? fetch,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const absent = message.includes("absent from the PyPI index");
		return {
			...base,
			provenance: absent ? "absent-from-pypi" : "error",
			error: message,
		};
	}
	const wheel = pickWheel(artifacts);
	if (!wheel)
		return { ...base, provenance: "record-only", error: "no wheel on PyPI" };
	try {
		return await auditWheel(base, wheel, deps, distInfoDir);
	} catch (err) {
		return {
			...base,
			provenance: "error",
			error: err instanceof Error ? err.message : String(err),
		};
	}
};

const finishWheelAudit = async (
	base: DistAudit,
	wheel: PypiArtifact,
	deps: AuditDeps,
	distInfo: string,
	digestMatch: boolean,
	digest: string,
): Promise<DistAudit> => {
	const sitePackages = deps.sitePackages ?? litellmSitePackages();
	const wheelPath = join(
		deps.cacheDir ?? "/tmp/litellm-integrity",
		wheel.filename,
	);
	const wheelRows = recordMap(
		(deps.unzipper ?? defaultUnzipper)(wheelPath, `${distInfo}/RECORD`),
	);
	const installedRows = recordMap(
		readFileSync(join(sitePackages, distInfo, "RECORD"), "utf8"),
	);
	const check = await verifyRecord(sitePackages, distInfo);
	const chained = digestMatch && wheelRecordCovered(wheelRows, installedRows);
	return {
		...base,
		wheel: wheel.filename,
		wheelDigestMatch: digestMatch,
		recordFiles: check.files,
		recordVerified: check.verified,
		provenance: chained
			? "wheel-digest+record"
			: digestMatch
				? "record-only"
				: "error",
		error: chained
			? undefined
			: digestMatch
				? "installed RECORD diverges from the published wheel RECORD"
				: `wheel digest mismatch (${digest.slice(0, 12)} vs published ${wheel.sha256.slice(0, 12)})`,
	};
};

/** The full provenance chain: published digest → wheel RECORD → installed
 *  RECORD → every installed file. */
const auditWheel = async (
	base: DistAudit,
	wheel: PypiArtifact,
	deps: AuditDeps,
	distInfo: string,
): Promise<DistAudit> => {
	const cacheDir = deps.cacheDir ?? "/tmp/litellm-integrity";
	mkdirSync(cacheDir, { recursive: true });
	const dest = join(cacheDir, wheel.filename);
	await (deps.downloader ?? defaultDownloader)(wheel.url, dest);
	const digest = await sha256File(dest);
	const digestMatch = digest === wheel.sha256;
	return finishWheelAudit(base, wheel, deps, distInfo, digestMatch, digest);
};

/** Audit every litellm-family dist; the compromised-version trigger
 *  outranks all — deindexed releases cannot be proven clean. */
export const auditLiteLlmEnv = async (
	deps: AuditDeps = {},
): Promise<IntegrityAudit> => {
	const sitePackages = deps.sitePackages ?? litellmSitePackages();
	const dists: DistAudit[] = [];
	for (const dir of distInfoDirs(sitePackages)) {
		dists.push(await auditOneDist(dir, deps));
	}
	const core = dists.find((d) => d.dist.toLowerCase() === "litellm");
	const compromised =
		core !== undefined && COMPROMISED_LITELLM_VERSIONS.includes(core.version);
	const tampered = dists.some(
		(d) => d.wheelDigestMatch === false || d.recordVerified === false,
	);
	const weak = dists
		.filter((d) => d.provenance !== "wheel-digest+record")
		.map((d) => d.dist)
		.join(", ");
	const verdict =
		compromised || tampered
			? "exposed"
			: core === undefined || core.version.length === 0 || weak.length > 0
				? "unverifiable"
				: "clean";
	const reason = compromised
		? `installed litellm ${core?.version} is the reported compromised release`
		: tampered
			? `digest/RECORD mismatch in ${weak || "the tool env"}`
			: verdict === "unverifiable"
				? `full hash chain unproven for ${weak || "no litellm-family dists"}`
				: `${dists.length} dist(s) fully proven against PyPI`;
	return {
		auditedAt: (deps.now ?? (() => new Date()))().toISOString(),
		spec: LITELLM_TOOL_SPEC,
		sitePackages,
		dists,
		litellmVersion: core?.version ?? null,
		compromisedVersions: COMPROMISED_LITELLM_VERSIONS,
		verdict,
		reason,
	};
};

/** One-line install-log evidence summary. */
export const integrityEvidence = (audit: IntegrityAudit): string => {
	const parts = audit.dists.map(
		(d) =>
			`${d.dist} ${d.version}${d.installDate ? ` (installed ${d.installDate.slice(0, 16).replace("T", " ")})` : ""} → ${d.provenance}`,
	);
	return `LiteLLM integrity ${audit.verdict.toUpperCase()}: ${audit.reason} — ${parts.join("; ")}`;
};

/** Machine-local integrity receipt (W1197): version + install date +
 *  hash evidence, written beside the runtime it audits. */
export const writeReceipt = (path: string, audit: IntegrityAudit): void => {
	writeFileSync(path, `${JSON.stringify(audit, null, "\t")}\n`);
};

const auditExitCode = (audit: IntegrityAudit): number =>
	audit.verdict === "clean" ? 0 : audit.verdict === "exposed" ? 1 : 2;
export { auditExitCode };

if (import.meta.main) {
	const sitePackages = process.argv[2] ?? litellmSitePackages();
	const audit = await auditLiteLlmEnv({ sitePackages });
	console.log(integrityEvidence(audit));
	console.log(JSON.stringify(audit, null, "\t"));
	process.exit(auditExitCode(audit));
}

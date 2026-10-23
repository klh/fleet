// litellm-integrity.test.ts — W1197 supply-chain integrity audit:
// fixture site-packages trees + stubbed PyPI/wheel/unzip seams; never
// touches the real uv tool env or the network.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuditDeps,
	COMPROMISED_LITELLM_VERSIONS,
	type IntegrityAudit,
	auditExitCode,
	auditLiteLlmEnv,
	b64urlToHex,
	distInfoDirs,
	integrityEvidence,
	parseRecord,
	pypiProjectName,
	pickWheel,
	readDistMeta,
	sha256File,
	verifyRecord,
	wheelRecordCovered,
	writeReceipt,
} from "../bin/litellm-integrity.ts";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "w1197-"));
const site = join(root, "site-packages");

const hexToB64url = (hex: string): string =>
	Buffer.from(hex, "hex").toString("base64url");

const shaHex = (body: string): string =>
	createHash("sha256").update(body).digest("hex");

/** Seeds a dist-info with REAL RECORD hashes over the given files. */
const seedDist = (
	name: string,
	version: string,
	files: Record<string, string>,
	target: string = site,
): string => {
	const distInfoDir = `${name}-${version}.dist-info`;
	const distInfo = join(target, distInfoDir);
	mkdirSync(distInfo, { recursive: true });
	const rows: string[] = [];
	for (const [rel, body] of Object.entries(files)) {
		const abs = join(target, rel);
		const parent = rel.split("/").slice(0, -1).join("/");
		if (parent.length > 0) mkdirSync(join(target, parent), { recursive: true });
		writeFileSync(abs, body);
		rows.push(`${rel},sha256=${hexToB64url(shaHex(body))},${body.length}`);
	}
	rows.push(`${distInfoDir}/RECORD,,`);
	writeFileSync(join(distInfo, "RECORD"), `${rows.join("\n")}\n`);
	writeFileSync(
		join(distInfo, "METADATA"),
		`Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n`,
	);
	return distInfoDir;
};

describe("litellm integrity helpers", () => {
	test("pypiProjectName normalizes per PEP 503", () => {
		expect(pypiProjectName("litellm_proxy_extras")).toBe(
			"litellm-proxy-extras",
		);
		expect(pypiProjectName("Litellm.Enterprise")).toBe("litellm-enterprise");
	});

	test("b64urlToHex decodes the RECORD base64url alphabet", () => {
		expect(b64urlToHex("LXEWQrcmsEQBYnyp-6wy9chTD7GQPMTbAiWHF5IaSIE")).toBe(
			"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
		);
	});

	test("parseRecord keeps hashless rows hashless", () => {
		const rows = parseRecord("a.py,sha256=AA,,\nRECORD,,\n");
		expect(rows[0]?.path).toBe("a.py");
		expect(rows[0]?.sha256).toBe("AA");
		expect(rows[1]?.sha256).toBeNull();
	});
});

describe("litellm integrity installed-tree checks", () => {
	test("sha256File hashes streaming", async () => {
		const path = join(root, "s.txt");
		writeFileSync(path, "x");
		expect(await sha256File(path)).toBe(shaHex("x"));
	});

	test("seedDist writes RECORD rows the verifier accepts", async () => {
		const dir = seedDist("litellm", "1.103.0", { "litellm/mod.py": "m" });
		const check = await verifyRecord(site, dir);
		expect(check.verified).toBe(true);
		expect(check.files).toBe(1);
	});

	test("verifyRecord flags a tampered file", async () => {
		const dir = seedDist("litellm_t", "1.103.0", { "t.py": "original" });
		writeFileSync(join(site, "t.py"), "tampered");
		const check = await verifyRecord(site, dir);
		expect(check.verified).toBe(false);
		expect(check.mismatches).toEqual(["t.py"]);
	});

	test("distInfoDirs keeps the litellm family only", () => {
		seedDist("litellm_proxy_extras", "0.2.0", { "px.py": "p" });
		seedDist("annotated_types", "0.7.0", { "at.py": "a" });
		expect(distInfoDirs(site)).toEqual([
			"litellm-1.103.0.dist-info",
			"litellm_proxy_extras-0.2.0.dist-info",
			"litellm_t-1.103.0.dist-info",
		]);
	});

	test("readDistMeta trusts METADATA over dirname", () => {
		expect(readDistMeta(join(site, "litellm-1.103.0.dist-info"))).toEqual({
			name: "litellm",
			version: "1.103.0",
		});
	});
});

describe("litellm integrity wheel selection", () => {
	const artifact = (filename: string): Record<string, unknown> => ({
		filename,
		sha256: "a".repeat(64),
		url: `https://files.pythonhosted.org/${filename}`,
		yanked: false,
		size: 1,
	});

	test("pickWheel prefers this machine's abi3 arm64 wheel", () => {
		const wheels = [
			artifact("litellm-1.103.0-py3-none-any.whl"),
			artifact("litellm-1.103.0-cp310-abi3-macosx_11_0_arm64.whl"),
		] as never;
		expect(pickWheel(wheels)?.filename).toBe(
			"litellm-1.103.0-cp310-abi3-macosx_11_0_arm64.whl",
		);
	});

	test("pickWheel returns null with no wheels", () => {
		expect(pickWheel([artifact("litellm-1.103.0.tar.gz")] as never)).toBeNull();
	});

	test("wheelRecordCovered demands every published row installed verbatim", () => {
		const wheel = new Map([
			["a.py", "h1"],
			["b.py", "h2"],
		]);
		expect(
			wheelRecordCovered(
				wheel,
				new Map([
					["b.py", "h2"],
					["a.py", "h1"],
				]),
			),
		).toBe(true);
		expect(
			wheelRecordCovered(
				wheel,
				new Map([
					["a.py", "h1"],
					["b.py", "h2"],
					["INSTALLER", "x"],
				]),
			),
		).toBe(true);
		expect(wheelRecordCovered(wheel, new Map([["a.py", "h1"]]))).toBe(false);
		expect(
			wheelRecordCovered(
				wheel,
				new Map([
					["a.py", "h1"],
					["b.py", "X"],
				]),
			),
		).toBe(false);
	});
});

// ─── auditLiteLlmEnv — stubbed PyPI/wheel/unzip seams, fixture trees ───

const wheelBody = "fake-wheel-bytes";
/** PyPI JSON-API wire shape: urls[] rows carry digests.sha256. */
const pyWheel = (filename: string, sha256 = shaHex(wheelBody)) => [
	{
		filename,
		digests: { sha256 },
		url: `https://files.pythonhosted.org/${filename}`,
		yanked: false,
		size: wheelBody.length,
	},
];

const makeDeps = (
	siteDir: string,
	releases: Record<string, ReturnType<typeof pyWheel>>,
	records: Record<string, string>,
): AuditDeps => ({
	sitePackages: siteDir,
	fetcher: ((input: unknown) => {
		const hit = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/([^/]+)\/json$/.exec(
			String(input),
		);
		const urls = hit ? releases[`${hit[1]} ${hit[2]}`] : undefined;
		return urls === undefined
			? Promise.resolve(new Response(null, { status: 404 }))
			: Promise.resolve(Response.json({ urls }));
	}) as unknown as typeof fetch,
	downloader: async (_url: string, dest: string): Promise<void> => {
		writeFileSync(dest, wheelBody);
	},
	unzipper: (_wheel: string, inner: string): string => {
		const text = records[inner.split("/")[0] ?? ""];
		if (text === undefined) throw new Error(`no fixture RECORD for ${inner}`);
		return text;
	},
	cacheDir: join(root, "wheel-cache"),
	now: () => new Date(0),
});

describe("auditLiteLlmEnv — clean chain", () => {
	test("proves wheel digest + RECORD + files for a pinned clean release", async () => {
		const siteDir = join(root, "audit-a");
		const distInfo = seedDist(
			"litellm",
			"1.103.0",
			{ "litellm/core.py": "core" },
			siteDir,
		);
		const record = readFileSync(join(siteDir, distInfo, "RECORD"), "utf8");
		const audit = await auditLiteLlmEnv(
			makeDeps(
				siteDir,
				{
					"litellm 1.103.0": pyWheel(
						"litellm-1.103.0-cp310-abi3-macosx_11_0_arm64.whl",
					),
				},
				{ [distInfo]: record },
			),
		);
		expect(audit.verdict).toBe("clean");
		expect(audit.litellmVersion).toBe("1.103.0");
		expect(audit.compromisedVersions).toContain("1.107.0");
		expect(audit.dists[0]?.provenance).toBe("wheel-digest+record");
		expect(audit.dists[0]?.recordFiles).toBe(1);
		expect(audit.dists[0]?.installDate).toBeTypeOf("string");
	});
});

describe("auditLiteLlmEnv — exposure", () => {
	test("compromised version trigger fires even when the release is deindexed", async () => {
		const siteDir = join(root, "audit-b");
		seedDist("litellm", "1.107.0", { "litellm/core.py": "c" }, siteDir);
		const audit = await auditLiteLlmEnv(makeDeps(siteDir, {}, {}));
		expect(audit.verdict).toBe("exposed");
		expect(audit.litellmVersion).toBe("1.107.0");
		expect(audit.reason).toContain("1.107.0");
		expect(audit.dists[0]?.provenance).toBe("absent-from-pypi");
		expect(COMPROMISED_LITELLM_VERSIONS).toContain("1.107.0");
	});

	test("a wheel digest mismatch counts as tampering", async () => {
		const siteDir = join(root, "audit-c");
		const distInfo = seedDist(
			"litellm",
			"1.103.0",
			{ "litellm/core.py": "core" },
			siteDir,
		);
		const record = readFileSync(join(siteDir, distInfo, "RECORD"), "utf8");
		const audit = await auditLiteLlmEnv(
			makeDeps(
				siteDir,
				{
					"litellm 1.103.0": pyWheel(
						"litellm-1.103.0-cp310-abi3-macosx_11_0_arm64.whl",
						shaHex("other-bytes"),
					),
				},
				{ [distInfo]: record },
			),
		);
		expect(audit.verdict).toBe("exposed");
		expect(audit.dists[0]?.provenance).toBe("error");
		expect(audit.dists[0]?.wheelDigestMatch).toBe(false);
	});
});

describe("auditLiteLlmEnv — degraded provenance", () => {
	test("an absent clean release degrades to unverifiable, never clean", async () => {
		const siteDir = join(root, "audit-d");
		seedDist("litellm", "1.103.0", { "litellm/core.py": "core" }, siteDir);
		const audit = await auditLiteLlmEnv(makeDeps(siteDir, {}, {}));
		expect(audit.verdict).toBe("unverifiable");
		expect(audit.dists[0]?.provenance).toBe("absent-from-pypi");
	});

	test("an installed RECORD diverging from the wheel is record-only", async () => {
		const siteDir = join(root, "audit-e");
		const distInfo = seedDist(
			"litellm",
			"1.103.0",
			{ "litellm/core.py": "core" },
			siteDir,
		);
		const wheelRecord = readFileSync(
			join(siteDir, distInfo, "RECORD"),
			"utf8",
		).replace(hexToB64url(shaHex("core")), hexToB64url(shaHex("divergent")));
		const audit = await auditLiteLlmEnv(
			makeDeps(
				siteDir,
				{
					"litellm 1.103.0": pyWheel(
						"litellm-1.103.0-cp310-abi3-macosx_11_0_arm64.whl",
					),
				},
				{ [distInfo]: wheelRecord },
			),
		);
		expect(audit.verdict).toBe("unverifiable");
		expect(audit.dists[0]?.provenance).toBe("record-only");
		expect(audit.dists[0]?.recordVerified).toBe(true);
	});
});

describe("integrity evidence, receipt and exit code", () => {
	test("integrityEvidence carries verdict, reason and install dates", async () => {
		const siteDir = join(root, "audit-f");
		seedDist("litellm", "1.103.0", { "litellm/core.py": "core" }, siteDir);
		const audit = await auditLiteLlmEnv(makeDeps(siteDir, {}, {}));
		const evidence = integrityEvidence(audit);
		expect(evidence).toContain("UNVERIFIABLE");
		expect(evidence).toContain("1.103.0");
		expect(evidence).toContain("unproven");
	});

	test("writeReceipt round-trips the audit JSON", async () => {
		const siteDir = join(root, "audit-g");
		seedDist("litellm", "1.103.0", { "litellm/core.py": "core" }, siteDir);
		const audit = await auditLiteLlmEnv(makeDeps(siteDir, {}, {}));
		const path = join(siteDir, "litellm-integrity.json");
		writeReceipt(path, audit);
		const receipt = JSON.parse(readFileSync(path, "utf8")) as IntegrityAudit;
		expect(receipt.verdict).toBe(audit.verdict);
		expect(receipt.litellmVersion).toBe("1.103.0");
	});

	test("auditExitCode maps verdicts to 0/1/2", () => {
		const audit = (
			verdict: "clean" | "exposed" | "unverifiable",
		): IntegrityAudit => ({
			auditedAt: "1970-01-01T00:00:00.000Z",
			spec: "litellm[proxy]==1.103.0",
			sitePackages: "/site",
			dists: [],
			litellmVersion: "1.103.0",
			compromisedVersions: ["1.107.0"],
			verdict,
			reason: "test",
		});
		expect(auditExitCode(audit("clean"))).toBe(0);
		expect(auditExitCode(audit("exposed"))).toBe(1);
		expect(auditExitCode(audit("unverifiable"))).toBe(2);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});
});

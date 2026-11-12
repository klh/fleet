import { uploadPreflight } from "./preflight.ts";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineVerb, runCli } from "../../../hooks/lib/verb-kit.ts";
import {
	AcceptanceSchema,
	DigestSchema,
	ReleaseRequestSchema,
} from "./contract.ts";
import {
	parseJson,
	verifyArtifacts,
	type AcceptanceArtifact,
} from "./evidence.ts";
import { registryPreflight, releasePlan, checkedAcceptance } from "./plan.ts";
import { boundedCommand, productionDriver } from "./registry.ts";
import { publishCandidate, promoteCandidate } from "./workflow.ts";
import { verifyPublication } from "./verify.ts";

async function bytes(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024)
			throw new Error("Input file byte/type bound");
		const buffer = new Uint8Array(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await file.read(
				buffer,
				offset,
				buffer.length - offset,
				offset,
			);
			if (!read.bytesRead) throw new Error("Input file changed/truncated");
			offset += read.bytesRead;
		}
		const after = await file.stat();
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
			throw new Error("Input file changed");
		return buffer;
	} finally {
		await file.close();
	}
}
const ArtifactFilesSchema = z
	.array(
		z.strictObject({
			platform: z.enum(["linux/amd64", "linux/arm64"]),
			closure: z.string().min(1),
			report: z.string().min(1),
		}),
	)
	.min(1)
	.max(2);
export async function loadInputs(
	requestPath: string,
	acceptancePath: string,
	artifactsPath: string,
) {
	const request = ReleaseRequestSchema.parse(
		parseJson(await bytes(requestPath)),
	);
	const acceptance = AcceptanceSchema.parse(
		parseJson(await bytes(acceptancePath)),
	);
	const paths = ArtifactFilesSchema.parse(
		parseJson(await bytes(artifactsPath)),
	);
	const artifacts: AcceptanceArtifact[] = [];
	for (const item of paths)
		artifacts.push({
			platform: item.platform,
			closure: await bytes(resolve(dirname(artifactsPath), item.closure)),
			report: await bytes(resolve(dirname(artifactsPath), item.report)),
		});
	checkedAcceptance(request, acceptance);
	if (artifacts.length !== request.platforms.length)
		throw new Error("Artifact coverage mismatch");
	for (const receipt of acceptance) verifyArtifacts(receipt, artifacts);
	return { request, acceptance, artifacts };
}
const repository = resolve(import.meta.dir, "../../../../..");
const flags = [
	"--request",
	"--acceptance",
	"--artifacts",
	"--output",
	"--digest",
];
export async function main() {
	await runCli({
		prog: "supervisor-release",
		about:
			"Pinned private supervisor-seed candidate, verification and promotion.",
		verbs: [
			defineVerb({
				name: "preflight",
				usage: "supervisor-release preflight",
				run: async () => {
					const driver = await productionDriver(repository);
					console.log(
						JSON.stringify(uploadPreflight(await driver.metadata()), null, 2),
					);
				},
			}),
			...["plan", "candidate", "verify", "promote"].map((name) =>
				defineVerb({
					name,
					usage:
						"supervisor-release " +
						name +
						" --request FILE --acceptance FILE --artifacts FILE [--digest sha256:HEX] [--output NEWFILE] [--execute]",
					flags,
					switches: ["--execute"],
					reqFlags: ["--request", "--acceptance", "--artifacts"],
					run: async (parsed) => {
						const inputs = await loadInputs(
							z.string().parse(parsed.flag("--request")),
							z.string().parse(parsed.flag("--acceptance")),
							z.string().parse(parsed.flag("--artifacts")),
						);
						for (const commit of [
							inputs.request.sourceCommit,
							inputs.request.recipeCommit,
						])
							await boundedCommand(
								[
									"git",
									"--no-replace-objects",
									"cat-file",
									"-e",
									`${commit}^{commit}`,
								],
								repository,
							);
						let result: unknown;
						if (name === "plan") {
							if (parsed.flag("--execute"))
								throw new Error("Plan never executes");
							const driver = await productionDriver(repository);
							const imageMetadata = await driver.imageMetadata(
								inputs.request.sourceCommit,
								inputs.request.recipeCommit,
							);
							result = releasePlan(
								inputs.request,
								inputs.acceptance,
								imageMetadata,
							);
						} else {
							if (
								(name === "candidate" || name === "promote") &&
								!parsed.flag("--execute")
							)
								throw new Error(
									"Mutation requires explicit --execute; obtain authorization separately",
								);
							if (
								(name === "verify" || name === "promote") &&
								!parsed.flag("--digest")
							)
								throw new Error("Exact --digest required");
							const driver = await productionDriver(repository);
							if (name === "candidate")
								result = await publishCandidate(
									inputs.request,
									inputs.acceptance,
									inputs.artifacts,
									driver,
								);
							else if (name === "promote")
								result = await promoteCandidate(
									inputs.request,
									inputs.acceptance,
									parsed.flag("--digest"),
									inputs.artifacts,
									driver,
								);
							else {
								registryPreflight(await driver.metadata());
								const imageMetadata = await driver.imageMetadata(
									inputs.request.sourceCommit,
									inputs.request.recipeCommit,
								);
								result = await verifyPublication(
									inputs.request,
									inputs.acceptance,
									imageMetadata,
									DigestSchema.parse(parsed.flag("--digest")),
									driver.read,
									inputs.artifacts,
								);
							}
						}
						const json = `${JSON.stringify(result, null, 2)}\n`;
						const output = parsed.flag("--output");
						if (output)
							await writeFile(output, json, { flag: "wx", mode: 0o600 });
						else console.log(json);
					},
				}),
			),
		],
	});
}
if (import.meta.main)
	main().catch((error) => {
		const reason =
			error instanceof Error ? error.message.slice(0, 4096) : "unknown failure";
		console.error(
			"supervisor-release: " +
				reason +
				"; inspect registry/output before retrying",
		);
		process.exitCode = 1;
	});

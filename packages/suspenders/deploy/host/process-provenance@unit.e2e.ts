import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const sourceCommit = "0247a701b9a9691c123c826bb937235be874a1f4";
const paths = [
	"packages/suspenders/deploy/host/process-guardian.ts",
	"packages/suspenders/deploy/host/process-protocol.ts",
	"packages/suspenders/deploy/host/process.ts",
] as const;
const ProcessProvenanceSchema = z.strictObject({
	schemaVersion: z.literal(1),
	sourceCommit: z.literal(sourceCommit),
	files: z
		.array(
			z.strictObject({
				path: z.enum(paths),
				gitBlob: z.string().regex(/^[0-9a-f]{40}$/),
				sha256: z.string().regex(/^[0-9a-f]{64}$/),
			}),
		)
		.length(paths.length)
		.refine(
			(files) => new Set(files.map((file) => file.path)).size === paths.length,
			"Paths must be unique",
		),
});

test("immutable process provenance matches all current helper bytes without Git objects", () => {
	const file = join(import.meta.dir, "process-provenance.json");
	expect(existsSync(file)).toBe(true);
	const manifest = ProcessProvenanceSchema.parse(
		JSON.parse(readFileSync(file, "utf8")),
	);
	const root = resolve(import.meta.dir, "../../../..");
	for (const entry of manifest.files) {
		const path = join(root, entry.path);
		expect(lstatSync(path).isFile(), entry.path).toBe(true);
		const bytes = readFileSync(path);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const gitBlob = createHash("sha1")
			.update("blob ")
			.update(String(bytes.byteLength))
			.update(new Uint8Array([0]))
			.update(bytes)
			.digest("hex");
		expect(sha256, entry.path).toBe(entry.sha256);
		expect(gitBlob, entry.path).toBe(entry.gitBlob);
	}
});

test("provenance accepts only the three unique repository paths and exact source identity", () => {
	const fixture = {
		schemaVersion: 1,
		sourceCommit,
		files: paths.map((path) => ({
			path,
			gitBlob: "0".repeat(40),
			sha256: "0".repeat(64),
		})),
	};
	expect(ProcessProvenanceSchema.safeParse(fixture).success).toBe(true);
	for (const path of [
		"/outside/process.ts",
		"../process.ts",
		"packages/suspenders/deploy/host/other.ts",
	]) {
		const files = fixture.files.map((file, index) =>
			index === 0 ? { ...file, path } : file,
		);
		expect(
			ProcessProvenanceSchema.safeParse({ ...fixture, files }).success,
		).toBe(false);
	}
	expect(
		ProcessProvenanceSchema.safeParse({
			...fixture,
			files: [fixture.files[0], fixture.files[0], fixture.files[2]],
		}).success,
	).toBe(false);
	expect(
		ProcessProvenanceSchema.safeParse({
			...fixture,
			sourceCommit: "f".repeat(40),
		}).success,
	).toBe(false);
	expect(
		ProcessProvenanceSchema.safeParse({ ...fixture, extra: true }).success,
	).toBe(false);
});

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "../file-lock.ts";
import { legacyNameOf, writeJsonConf } from "../kernel-conf.ts";
import { resolvePosture } from "./posture.resolve.ts";
import { parsePostureDocument, type PostureDocument } from "./posture.zod.ts";

export interface PostureSnapshot {
	document: PostureDocument;
	revision: string;
}

export interface StackPostureSnapshot {
	document: PostureDocument | null;
	revision: string;
}

const revisionOf = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

export function readPostureConfig(path: string): PostureSnapshot {
	const text = readFileSync(path, "utf8");
	const document = parsePostureDocument(text, path);
	resolvePosture(document, []);
	return { document, revision: revisionOf(text) };
}

function currentRevision(path: string): string | null {
	try {
		return revisionOf(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

function assertRevision(path: string, expected: string | null): void {
	assertRevisionValue(path, currentRevision(path), expected);
}

function assertRevisionValue(
	path: string,
	current: string | null,
	expected: string | null,
): void {
	if (current !== expected)
		throw new Error(
			`${path}: configuration changed since the preview; reload before saving`,
		);
}

function checkedDocument(
	path: string,
	document: PostureDocument,
): PostureDocument {
	const checked = parsePostureDocument(JSON.stringify(document), path);
	resolvePosture(checked, []);
	return checked;
}

/** A null revision means create-only; writes share one cross-process lock. */
export function writePostureConfig(
	path: string,
	document: PostureDocument,
	expectedRevision: string | null,
): PostureSnapshot {
	const checked = checkedDocument(path, document);
	return withFileLock(path, () => {
		assertRevision(path, expectedRevision);
		writeJsonConf(path, checked);
		return readPostureConfig(path);
	});
}

export function savePostureSelection(
	path: string,
	selection: PostureDocument["selection"],
	expectedRevision: string,
): PostureSnapshot {
	return withFileLock(path, () => {
		assertRevision(path, expectedRevision);
		const current = readPostureConfig(path);
		const checked = checkedDocument(path, {
			...current.document,
			selection,
		});
		writeJsonConf(path, checked);
		return readPostureConfig(path);
	});
}

const stackJsonPath = (path: string): string =>
	path.replace(/\.ya?ml$/i, ".json");

function readStackEnvelope(path: string): {
	envelope: Record<string, unknown>;
	snapshot: StackPostureSnapshot;
} {
	const jsonPath = stackJsonPath(path);
	const sourcePath = existsSync(jsonPath) ? jsonPath : legacyNameOf(jsonPath);
	const text = readFileSync(sourcePath, "utf8");
	let envelope: unknown;
	try {
		envelope = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(`${sourcePath}: invalid JSON: ${error.message}`);
		throw error;
	}
	if (
		envelope === null ||
		typeof envelope !== "object" ||
		Array.isArray(envelope)
	)
		throw new Error(`${path}: stack configuration must be an object`);
	const root = envelope as Record<string, unknown>;
	const document = Object.hasOwn(root, "postures")
		? parsePostureDocument(
				JSON.stringify(root.postures),
				`${sourcePath}:postures`,
			)
		: null;
	if (document) resolvePosture(document, []);
	return {
		envelope: root,
		snapshot: { document, revision: revisionOf(text) },
	};
}

/** Absence is explicit: a machine without postures has not been migrated. */
export function readStackPostureConfig(path: string): StackPostureSnapshot {
	return readStackEnvelope(path).snapshot;
}

export function writeStackPostureConfig(
	path: string,
	document: PostureDocument,
	expectedRevision: string,
): StackPostureSnapshot {
	const checked = checkedDocument(`${path}:postures`, document);
	const target = stackJsonPath(path);
	return withFileLock(target, () => {
		const current = readStackEnvelope(path);
		assertRevisionValue(path, current.snapshot.revision, expectedRevision);
		writeJsonConf(target, { ...current.envelope, postures: checked });
		return readStackPostureConfig(path);
	});
}

export function saveStackPostureSelection(
	path: string,
	selection: PostureDocument["selection"],
	expectedRevision: string,
): StackPostureSnapshot {
	const target = stackJsonPath(path);
	return withFileLock(target, () => {
		const current = readStackEnvelope(path);
		assertRevisionValue(path, current.snapshot.revision, expectedRevision);
		if (!current.snapshot.document)
			throw new Error(`${path}:postures: configuration has not been migrated`);
		const checked = checkedDocument(`${path}:postures`, {
			...current.snapshot.document,
			selection,
		});
		writeJsonConf(target, { ...current.envelope, postures: checked });
		return readStackPostureConfig(path);
	});
}

/** Migration requires an explicit document; route availability is not policy. */
export function migrateStackPostureConfig(
	path: string,
	document: PostureDocument,
	expectedRevision: string,
): StackPostureSnapshot {
	const checked = checkedDocument(`${path}:postures`, document);
	const target = stackJsonPath(path);
	return withFileLock(target, () => {
		const current = readStackEnvelope(path);
		assertRevisionValue(path, current.snapshot.revision, expectedRevision);
		if (current.snapshot.document) {
			if (isDeepStrictEqual(current.snapshot.document, checked))
				return current.snapshot;
			throw new Error(
				`${path}:postures: already migrated to a different configuration`,
			);
		}
		const backupPath = `${target}.pre-postures.bak.json`;
		const backup = {
			revision: current.snapshot.revision,
			originalText: readFileSync(
				existsSync(target) ? target : legacyNameOf(target),
				"utf8",
			),
		};
		if (existsSync(backupPath)) {
			let previous: unknown;
			try {
				previous = JSON.parse(readFileSync(backupPath, "utf8"));
			} catch (error) {
				if (error instanceof SyntaxError)
					throw new Error(`${backupPath}: invalid JSON: ${error.message}`);
				throw error;
			}
			if (!isDeepStrictEqual(previous, backup))
				throw new Error(
					`${backupPath}: existing backup does not match the migration source`,
				);
		} else {
			writeJsonConf(backupPath, backup);
		}
		writeJsonConf(target, { ...current.envelope, postures: checked });
		return readStackPostureConfig(path);
	});
}

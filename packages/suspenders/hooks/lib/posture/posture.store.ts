import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { withFileLock } from "../file-lock.ts";
import { writeJsonConf } from "../kernel-conf.ts";
import { resolvePosture } from "./posture.resolve.ts";
import { parsePostureDocument, type PostureDocument } from "./posture.zod.ts";

export interface PostureSnapshot {
	document: PostureDocument;
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
	if (currentRevision(path) !== expected)
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

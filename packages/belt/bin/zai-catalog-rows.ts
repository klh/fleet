import { lstatSync, readFileSync } from "node:fs";

export const ZAI_CATALOG_URL = "https://api.z.ai/api/paas/v4/models";
export const ZAI_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The account /models endpoint currently returns chat GLM IDs but supplies
// no modality field. Do not turn image, OCR, or audio IDs into chat routes.
const MODEL_ID = /^glm-\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/;

export type ZaiCatalogSnapshot = {
	version: 1;
	source: typeof ZAI_CATALOG_URL;
	generated_at: string;
	model_ids: string[];
	excluded_model_ids: string[];
};

// Timestamp-only failure: carries the parsed snapshot so an installer can verify + refresh it.
export class ZaiSnapshotStaleError extends Error {
	constructor(readonly snapshot: ZaiCatalogSnapshot) {
		super("Z.ai catalog snapshot is stale; refresh before deploy");
		this.name = "ZaiSnapshotStaleError";
	}
}

// ONE snapshot path shared by the generator and the install preflight.
export const zaiCatalogFile = (
	home: string,
	env: Record<string, string | undefined> = process.env,
): string =>
	env.ZAI_CATALOG_FILE ?? `${home}/.claude/local-llm/zai-models.json`;

export function parseZaiModelIds(raw: unknown): {
	model_ids: string[];
	excluded_model_ids: string[];
} {
	if (
		!raw ||
		typeof raw !== "object" ||
		!Array.isArray((raw as { data?: unknown }).data)
	)
		throw new Error("Z.ai model catalog has no data array");
	const ids = (raw as { data: Array<{ id?: unknown }> }).data.map(
		(row) => row?.id,
	);
	if (ids.length === 0) throw new Error("Z.ai model catalog is empty");
	const chat = ids.filter(
		(id): id is string => typeof id === "string" && MODEL_ID.test(id),
	);
	// New non-chat (image/audio/OCR) IDs filter out instead of failing the
	// whole refresh; a chat GLM we cannot recognize still refuses loudly.
	const excluded = ids.filter(
		(id) => typeof id !== "string" || !MODEL_ID.test(id),
	) as string[];
	if (chat.length === 0)
		throw new Error(
			`Z.ai model catalog has no chat GLM models (excluded ${excluded.length})`,
		);
	return {
		model_ids: [...new Set(chat)].sort((a, b) => a.localeCompare(b)),
		excluded_model_ids: [...new Set(excluded)].sort((a, b) =>
			a.localeCompare(b),
		),
	};
}

export function validateZaiSnapshot(
	raw: unknown,
	now = Date.now(),
): ZaiCatalogSnapshot {
	const doc = raw as Partial<ZaiCatalogSnapshot> | null;
	if (
		doc?.version !== 1 ||
		doc.source !== ZAI_CATALOG_URL ||
		!Array.isArray(doc.model_ids) ||
		doc.model_ids.length === 0 ||
		doc.model_ids.some((id) => typeof id !== "string" || !MODEL_ID.test(id))
	)
		throw new Error("invalid Z.ai catalog snapshot");
	const excluded = Array.isArray(doc.excluded_model_ids)
		? doc.excluded_model_ids
		: [];
	const snapshot = {
		...doc,
		excluded_model_ids: [...excluded],
	} as ZaiCatalogSnapshot;
	const age = now - Date.parse(doc.generated_at ?? "");
	if (!Number.isFinite(age) || age < 0 || age > ZAI_CATALOG_MAX_AGE_MS)
		throw new ZaiSnapshotStaleError(snapshot);
	return snapshot;
}

export function readZaiSnapshot(
	path: string,
	now = Date.now(),
): ZaiCatalogSnapshot {
	if (!path.startsWith("/"))
		throw new Error("Z.ai catalog path must be absolute");
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new Error("Z.ai catalog path must be a private regular file (0600)");
	return validateZaiSnapshot(JSON.parse(readFileSync(path, "utf8")), now);
}

export function zaiLiteLlmRows(
	snapshot: ZaiCatalogSnapshot,
	template: string,
	existingNames: ReadonlySet<string> = new Set(),
): string[] {
	if (
		!/^[ \t]*- model_name: zai-glm-[^\n]+$/m.test(template) ||
		!/^[ \t]*model: zai\/glm-[^\n]+$/m.test(template) ||
		!/^[ \t]*api_key: os\.environ\/Z_AI_API_KEY$/m.test(template)
	)
		throw new Error("Z.ai model rows need a validated Z.ai remote template");
	return snapshot.model_ids
		.filter((id) => !existingNames.has(`zai-${id}`))
		.map((id) =>
			template
				.replace(
					/^[ \t]*- model_name: zai-glm-[^\n]+$/m,
					`  - model_name: zai-${id}`,
				)
				.replace(/^[ \t]*model: zai\/glm-[^\n]+$/m, `      model: zai/${id}`),
		);
}

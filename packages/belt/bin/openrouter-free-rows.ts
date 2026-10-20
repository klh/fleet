// A private, recently refreshed catalog snapshot supplies optional LiteLLM
// rows. The Buckle front uses the same model_name and keeps its own auth.
import { readFileSync } from "node:fs";

const SOURCE = "https://openrouter.ai/api/v1/models";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const FREE_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*:free$/i;

type Snapshot = {
	version?: unknown;
	source?: unknown;
	generated_at?: unknown;
	groups?: Record<string, Array<{ model?: unknown }>>;
};

export function openRouterFreeRows(path: string, now = Date.now()): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const doc = JSON.parse(raw) as Snapshot;
	const age = now - Date.parse(String(doc.generated_at));
	if (
		doc.version !== 1 ||
		doc.source !== SOURCE ||
		!doc.groups ||
		!Number.isFinite(age) ||
		age < 0 ||
		age > MAX_AGE_MS
	)
		throw new Error("OpenRouter free catalog snapshot is invalid or stale");
	const rows: string[] = [];
	for (const [group, deployments] of Object.entries(doc.groups)) {
		const id = group.slice("openrouter/".length);
		if (
			!group.startsWith("openrouter/") ||
			!FREE_ID.test(id) ||
			!Array.isArray(deployments) ||
			deployments.length !== 1 ||
			deployments[0]?.model !== group
		)
			throw new Error("OpenRouter free catalog route is invalid");
		rows.push(
			`  - model_name: ${JSON.stringify(group)}\n` +
				`    litellm_params:\n` +
				`      model: ${JSON.stringify(group)}\n` +
				`      api_key: os.environ/OPENROUTER_API_KEY`,
		);
	}
	return rows.sort();
}

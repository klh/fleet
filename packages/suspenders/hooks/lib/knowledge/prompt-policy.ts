// hooks/lib/knowledge/prompt-policy.ts — the distill prompt policy: knowledgeworker.md
// resolved per request (config-over-code), inline fallback, and the
// parser-version hash the reprocess checkpoint compares (W244). Split from
// knowledge-ports.ts (W1255.3); the store port lives in ./store-schema.ts,
// the SQLite adapter in ./sqlite-store.ts, the distill clients in
// ./distill-clients.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// W244: the prompt file resolves per request — KNOWLEDGE_PROMPT_FILE is the
// config-over-code override (enterprise gateway, tests); unset → the shipped
// hooks/knowledgeworker.md.
const PROMPT_FILE = (): string =>
	process.env.KNOWLEDGE_PROMPT_FILE ??
	join(import.meta.dir, "..", "..", "knowledgeworker.md");

// knowledgeworker.md: config-over-code — re-read at REQUEST time so prompt
// edits apply to the next queued job without a restart (#6)
export function systemPrompt(): string {
	try {
		return readFileSync(PROMPT_FILE(), "utf8");
	} catch {
		return "";
	}
}

// missing prompt file → minimal inline fallback, never a dead worker
const FALLBACK_PROMPT =
	"You are an impartial indexer for a fleet knowledge store. You do not evaluate truth, quality, or usefulness — you describe, condense, link, and timestamp. Return ONLY a JSON array. Each element: {topic, fact, confidence 0..1, domain, area, origin_kind (lesson|incident|decision|study|fact), origin_system, supersedes_id (only when the source text EXPLICITLY declares it replaces/corrects a row, else null), source_ref (REQUIRED when the payload names a doc path: the repo-relative path of that exact doc, else null)}. Never copy credentials into facts — redact as [REDACTED] or reject. Substitution contract: never restate what one file/doc already teaches — pointer-ize (source_ref + non-obvious residue) or reject. Corrections create a new row via supersedes_id; history is append-only.";

// W244 — the ACTIVE prompt is what a distill request sends right now (both
// clients fall back identically when the file is absent); its sha256 is the
// parser version the reprocess checkpoint compares queue rows against.
export const activePrompt = (): string => systemPrompt() || FALLBACK_PROMPT;
export const currentPromptHash = (): string =>
	createHash("sha256").update(activePrompt()).digest("hex");

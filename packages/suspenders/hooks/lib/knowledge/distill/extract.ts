// distill/extract.ts — deterministic entity extractors. The walker pulls
// entities out of every entry with these FIRST (repo paths, packages, W-ids,
// commit shas, ports, launchd labels, config knobs, model ids); the LLM only
// supplies typed relations the extractors cannot see. Pure functions — no
// I/O — so the e2e suite pins them table-style.
import type { EdgeType, NodeKind } from "./graph.ts";

export interface Entity {
	kind: NodeKind;
	key: string;
	label: string;
}

const PATH_RE =
	/\b(?:packages|hooks|scripts|src|deploy|docs|tests?|bin|lib|e2e|skills)\/[\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|js|mjs|json|md|ya?ml|toml|plist|sql|sh|py)\b/g;
const PKG_RE = /@klh\/[a-z][\w-]*/g;
const PKG_DIR_RE = /\bpackages\/([a-z][\w-]*)\//g;
const WID_RE = /\bW\d{2,5}(?:\.\d+)*\b/g;
const SHA_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,40}\b/g;
const PORT_RE = /(?:^|[\s(,`'"])(:\d{4,5})\b/g;
const LAUNCHD_RE =
	/\bcom\.(?:suspenders|belt|klh-local|klh)\.[a-z][\w.-]*[a-z\d]/g;
const KNOB_RE =
	/\b(?:SUSPENDERS|BUCKLE|BELT|KLH|DECANT|ORACLE|INGEST|GOVERNOR)_[A-Z0-9_]{2,}\b/g;
const MODEL_RE =
	/\b(?:glm-\d+(?:\.\d+)?(?:-(?:flash|air))?|claude-(?:opus|sonnet|haiku)-[\d.-]*\d|gpt-[\w.-]*\d|qwen\d[\w.-]*)\b/gi;
const INCIDENT_RE = /\b(?:INC-\d{2,}|incident[:#-][\w-]{3,})/gi;

const all = (re: RegExp, text: string): string[] => {
	re.lastIndex = 0;
	return [...text.matchAll(re)].map((m) => m[1] ?? m[0]);
};

/** Every entity mentioned in `text`, deduped by (kind, key). */
export function extractEntities(text: string): Entity[] {
	const out = new Map<string, Entity>();
	const add = (kind: NodeKind, key: string, label = key): void => {
		const k = key.trim();
		if (k && !out.has(`${kind}\0${k}`))
			out.set(`${kind}\0${k}`, { kind, key: k, label });
	};
	for (const p of all(PATH_RE, text)) add("code", p);
	for (const p of all(PKG_RE, text))
		add("package", p.replace(/^@klh\//, ""), p);
	for (const p of all(PKG_DIR_RE, text)) add("package", p);
	for (const w of all(WID_RE, text)) add("work_item", w);
	for (const s of all(SHA_RE, text)) add("commit", s.slice(0, 12), s);
	for (const p of all(PORT_RE, text)) add("service", p);
	for (const l of all(LAUNCHD_RE, text)) add("service", l);
	for (const k of all(KNOB_RE, text)) add("config_key", k);
	for (const m of all(MODEL_RE, text)) add("model", m.toLowerCase());
	for (const i of all(INCIDENT_RE, text)) add("incident", i.toLowerCase());
	return [...out.values()];
}

/** The repo path a source_ref points at (`path`, `path:line`, `path — why`). */
export function refPath(ref: string | null | undefined): string | null {
	if (!ref) return null;
	const head = ref.trim().split(/\s+/)[0] ?? "";
	const path = head.replace(/:\d+(?::\d+)?$/, "");
	return /[\w-]\/[\w@.-]+\.\w+$/.test(path) ? path : null;
}

const LESSON_KINDS = new Set(["lesson", "gotcha", "convention", "decision"]);

/** The edge an entry gets to one of its entities. Lessons APPLY to the code,
 *  services and knobs they name; everything else mentions. */
export function relationFor(
	entity: Entity,
	entry: { originKind: string | null; topic: string },
): EdgeType {
	const lessonish =
		(entry.originKind && LESSON_KINDS.has(entry.originKind)) ||
		/^lesson\b/i.test(entry.topic);
	if (
		lessonish &&
		(entity.kind === "code" ||
			entity.kind === "service" ||
			entity.kind === "config_key")
	)
		return "applies_to";
	return "mentions";
}

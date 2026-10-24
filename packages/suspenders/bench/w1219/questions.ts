// bench/w1219 — the text-to-SQL question set over the REAL sink schema
// (W1217 knowledge.db: knowledge + knowledge_claims + knowledge_proposals
// + knowledge_queue). W1219 measures candidates on valid-SQL rate and
// latency; the winner pins as the /knowledge/query translator upstream.
// Gold is EXECUTION-matched (Spider convention): the candidate's SQL runs
// read-only on the replica and the result set must equal the gold SQL's
// result set (order-insensitive). Danish questions ride the same gold.
export type Lang = "en" | "da";

export interface Question {
	id: string;
	lang: Lang;
	// The ask, phrased as /knowledge/query would receive it.
	q: string;
	// The reference query — verified against the seeded replica before any
	// candidate runs (a broken gold invalidates the whole run).
	gold_sql: string;
	// Which sink table(s) the question targets (for per-table breakdown).
	tables: string[];
}

export const QUESTIONS: Question[] = [
	{
		id: "Q01",
		lang: "en",
		q: "How many knowledge rows are in the active state?",
		gold_sql: "SELECT COUNT(*) FROM knowledge WHERE state = 'active'",
		tables: ["knowledge"],
	},
	{
		id: "Q02",
		lang: "en",
		q: "How many claims have been tombstoned (retracted), and what is their average confidence?",
		gold_sql:
			"SELECT COUNT(*), AVG(confidence) FROM knowledge_claims WHERE tombstone = 1",
		tables: ["knowledge_claims"],
	},
	{
		id: "Q03",
		lang: "en",
		q: "List the topic and fact of the 5 highest-confidence active knowledge rows, highest first.",
		gold_sql:
			"SELECT topic, fact FROM knowledge WHERE state = 'active' ORDER BY confidence DESC, id LIMIT 5",
		tables: ["knowledge"],
	},
	{
		id: "Q04",
		lang: "en",
	q: "Which machines have rolled claims up to the sink, and how many claims did each roll?",
		gold_sql:
			"SELECT origin_machine, COUNT(*) FROM knowledge_claims WHERE tombstone = 0 GROUP BY origin_machine ORDER BY origin_machine",
		tables: ["knowledge_claims"],
	},
	{
		id: "Q05",
		lang: "da",
		q: "Hvor mange claims er der i alt, og hvor mange af dem er ikke tombstoned?",
		gold_sql:
			"SELECT COUNT(*), SUM(tombstone = 0) FROM knowledge_claims",
		tables: ["knowledge_claims"],
	},
	{
		id: "Q06",
		lang: "da",
		q: "Vis de 5 nyeste aktive knowledge-emner (topic), nyeste først.",
		gold_sql:
			"SELECT topic FROM knowledge WHERE state = 'active' ORDER BY ts DESC, id LIMIT 5",
		tables: ["knowledge"],
	},
	{
		// JSON provenance extraction — the W1213 provenance column is a JSON
		// array of {machine, ts, retract?} entries.
		id: "Q07",
		lang: "en",
		q: "For claim evidence w-l2, what is the total number of provenance entries across all its versions?",
		gold_sql:
			"SELECT SUM(json_array_length(provenance)) FROM knowledge_claims WHERE evidence_id = 'w-l2'",
		tables: ["knowledge_claims"],
	},
	{
		id: "Q08",
		lang: "en",
		q: "How many distinct knowledge topics come from origin kind 'lane'?",
		gold_sql:
			"SELECT COUNT(DISTINCT topic) FROM knowledge WHERE origin_kind = 'lane'",
		tables: ["knowledge"],
	},
	{
		id: "Q09",
		lang: "da",
		q: "Hvor mange åbne retirement-forslag er der, og hvad er den højeste score?",
		gold_sql:
			"SELECT COUNT(*), MAX(score) FROM knowledge_proposals WHERE state = 'open'",
		tables: ["knowledge_proposals"],
	},
	{
		id: "Q10",
		lang: "en",
		q: "List the claim text and confidence of the 3 highest-confidence live (non-tombstoned) claims for evidence w-l1.",
		gold_sql:
			"SELECT claim, confidence FROM knowledge_claims WHERE evidence_id = 'w-l1' AND tombstone = 0 ORDER BY confidence DESC, version DESC LIMIT 3",
		tables: ["knowledge_claims"],
	},
	{
		id: "Q11",
		lang: "da",
		q: "Hvilke kilder (source-kolonnen) har bidraget knowledge-rækker, og hvor mange fra hver?",
		gold_sql:
			"SELECT source, COUNT(*) FROM knowledge GROUP BY source ORDER BY source",
		tables: ["knowledge"],
	},
	{
		id: "Q12",
		lang: "en",
		q: "Join: for evidence w-l1, list each claim version, its confidence, and the claim's live knowledge topic (knowledge.id = evidence_id numeric part).",
		gold_sql:
			"SELECT k.topic, c.version, c.confidence FROM knowledge_claims c JOIN knowledge k ON k.id = CAST(SUBSTR(c.evidence_id, 6) AS INTEGER) WHERE c.evidence_id = 'w-l1' ORDER BY c.version",
		tables: ["knowledge", "knowledge_claims"],
	},
];

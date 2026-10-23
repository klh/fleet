// src/router-fixtures.ts — kit-row/kit-pool/kit-sse (W1135.1.5): the buckle
// router-test factories folded once, semantics verbatim from the best
// existing copies. candidateRow = test/affinity.test.ts row() (the seq
// double-increment quirk included); poolOf = test/candidates.test.ts
// entries variant; poolOfUrl = the url variant parameterized by group +
// dialect; sseHeaders/enc = the per-file SSE consts. Structural mirrors —
// the kit is a leaf and never imports buckle; the union members match
// src/candidates.ts / src/upstreams.ts byte-for-byte so kit rows/pools are
// assignable where CandidateRow/UpstreamPool are expected.
export interface KitCandidateRow {
	candidate_id: string;
	kind: "local" | "remote" | "cloud";
	host: string;
	port: number;
	model: string;
	dialect: "openai" | "anthropic";
	group: string;
	capability_text: string;
	dep: {
		group: string;
		url: string;
		dialect: "openai" | "anthropic";
	};
	healthy: boolean;
	estimate_ms: number | null;
	calls: number;
	errors: number;
	load: number;
	last_used: string | null;
}

let rowSeq = 0;
/** CandidateRow factory — defaults verbatim from test/affinity.test.ts
 *  row(); the module-level counter keeps candidate_ids unique across files
 *  in one process. */
export const candidateRow = (
	over: Partial<KitCandidateRow> = {},
): KitCandidateRow => ({
	candidate_id: `h:${String(9000 + rowSeq++)}:m`,
	kind: "local",
	host: "h",
	port: 9000 + rowSeq,
	model: "m",
	dialect: "anthropic",
	group: "g",
	capability_text: "m",
	dep: {
		group: "g",
		url: `http://h:${String(9000 + rowSeq)}`,
		dialect: "anthropic",
	},
	healthy: true,
	estimate_ms: null,
	calls: 0,
	errors: 0,
	load: 0,
	last_used: null,
	...over,
});

export interface KitPoolDeployment {
	group: string;
	url: string;
	dialect: "openai" | "anthropic";
}

export interface KitUpstreamPool {
	groups(): string[];
	deployments(group: string): KitPoolDeployment[];
}

/** Group→URLs pool — verbatim test/candidates.test.ts poolOf (openai
 *  dialect, like the audited copy). */
export const poolOf = (entries: Array<[string, string[]]>): KitUpstreamPool => {
	const map = new Map(entries);
	return {
		groups: () => [...map.keys()],
		deployments: (g) =>
			(map.get(g) ?? []).map((url) => ({
				group: g,
				url,
				dialect: "openai" as const,
			})),
	};
};

export interface PoolOfUrlOpts {
	/** Single group name (default "claude-sonnet-5" — the audited url-variant
	 *  copy's literal). */
	group?: string;
	/** Deployment dialect (default "anthropic"). */
	dialect?: "openai" | "anthropic";
}

/** Single-URL pool — the url-variant poolOf copies (stream-outcome et al)
 *  parameterized by the only two things they ever differed in. */
export const poolOfUrl = (
	url: string,
	opts: PoolOfUrlOpts = {},
): KitUpstreamPool => {
	const group = opts.group ?? "claude-sonnet-5";
	const dialect = opts.dialect ?? "anthropic";
	return {
		groups: () => [group],
		deployments: (g) => [{ group: g, url, dialect }],
	};
};

/** The per-file SSE response-header const, verbatim. */
export const sseHeaders: Record<string, string> = {
	"content-type": "text/event-stream",
};

/** The per-file TextEncoder const (callers alias: `sseEnc as enc`). */
export const sseEnc = new TextEncoder();

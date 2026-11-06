// src/gov/mcp-scopes.ts — W2791: the MCP method-level scope family.
// Gravitee capability 2/3 (protocol-aware governance): a bksk_ key may
// discover (tools/list) without invoking (tools/call), and invocation can
// be pinned to a tool glob. Grammar (the item sketch, landed as the ONE
// engine in buckle — consumer faces mirror constants, the knowledge-query
// pattern):
//
//   buckle:mcp:<server>:LIST_                    tools/list on that server
//   buckle:mcp:<server>:CALL_                    tools/call, any tool
//   buckle:mcp:<server>:CALL_:<tool-glob>        tools/call, glob-pinned
//   buckle:mcp:<server>:READ_                    resources/read|list
//
// Implication lattice (same server only): CALL_ ⊃ LIST_ (mirrors WRITE_ ⊃
// READ_); server-wide CALL_ ⊃ any glob'd CALL_ need; a glob'd holder NEVER
// satisfies a wider need (least-privilege is structural); READ_ implies
// nothing else. No server wildcards — inspectable strings only, the W141
// law. Root principals do NOT get MCP scopes enumerated in ALL_SCOPES (the
// family is open-ended): the authorize seam bypasses on kind === "root".
//
// No live face enforces this yet (the item gates activation on a second
// human MCP surface); mint + storage + implication are proven by
// test/mcp-scopes.e2e.ts so the grammar cannot rot before first use.

/** Servers are kebab/lower names; globs add `*` over tool-name chars. */
const SERVER_RE = /^[a-z0-9-]+$/;
const TOOL_GLOB_RE = /^[A-Za-z0-9_*.-]+$/;
const ROLE_SEGMENTS = ["LIST_", "CALL_", "READ_"] as const;

export type McpMethodClass = (typeof ROLE_SEGMENTS)[number];

export interface McpScope {
	server: string;
	methodClass: McpMethodClass;
	/** Present only on glob-pinned CALL_ scopes. */
	toolGlob: string | null;
}

const MCP_PREFIX = "buckle:mcp:";

/** Parse one MCP scope string; null when not well-formed. Fails LOUD on the
 *  near-miss family: `buckle:mcp:READ_` (server missing), a bare server
 *  (`buckle:mcp:knowledge`), globs on LIST_/READ_ (nothing to pin), and any
 *  `:` beyond the glob segment. */
export function parseMcpScope(raw: string): McpScope | null {
	const s = raw.trim();
	if (!s.startsWith(MCP_PREFIX)) return null;
	const rest = s.slice(MCP_PREFIX.length).split(":");
	if (rest.length < 2 || rest.length > 3) return null;
	const [server, role, glob] = rest as [string, string, string?];
	if (!SERVER_RE.test(server ?? "") || !ROLE_SEGMENTS.includes(role as never))
		return null;
	if (role !== "CALL_" && glob !== undefined) return null;
	if (glob !== undefined && !TOOL_GLOB_RE.test(glob)) return null;
	return {
		server,
		methodClass: role as McpMethodClass,
		toolGlob: glob ?? null,
	};
}

const mcpScopeToString = (m: McpScope): string =>
	m.toolGlob === null
		? `${MCP_PREFIX}${m.server}:${m.methodClass}`
		: `${MCP_PREFIX}${m.server}:${m.methodClass}:${m.toolGlob}`;

/** MCP wire method → method class (tools/call names a tool; resources
 *  discovery rides READ_). Unknown methods are the face's -32601, not a
 *  scope decision — null here. */
export function mcpMethodClass(
	method: string,
): { methodClass: McpMethodClass; namesTool: boolean } | null {
	switch (method) {
		case "tools/list":
			return { methodClass: "LIST_", namesTool: false };
		case "tools/call":
			return { methodClass: "CALL_", namesTool: true };
		case "resources/read":
		case "resources/list":
			return { methodClass: "READ_", namesTool: false };
		default:
			return null;
	}
}

/** The scope one MCP request needs: server-wide when the method names no
 *  tool (or the face gates the whole surface), glob-segmented when a
 *  concrete tool is named. */
export function mcpScopeNeeded(
	server: string,
	method: string,
	tool?: string,
): string | null {
	const mc = mcpMethodClass(method);
	if (mc === null) return null;
	if (!SERVER_RE.test(server)) return null;
	if (mc.namesTool && typeof tool === "string" && tool.length > 0) {
		if (!TOOL_GLOB_RE.test(tool)) return null;
		return `${MCP_PREFIX}${server}:CALL_:${tool}`;
	}
	return `${MCP_PREFIX}${server}:${mc.methodClass}`;
}

/** Glob match over tool names: `*` spans name chars, everything else is
 *  literal. Boring on purpose — no `?`, no classes. */
function globMatch(glob: string, tool: string): boolean {
	const re = new RegExp(
		`^${glob
			.split("*")
			.map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("[A-Za-z0-9_.-]*")}$`,
	);
	return re.test(tool);
}

/** Implication for the MCP family. Holder satisfies need when: identical;
 *  same server and holder CALL_ where need is LIST_; or holder is a
 *  server-wide CALL_ / matching glob over a glob'd CALL_ need. A glob'd
 *  holder never widens. */
export function mcpScopeImplies(holder: string, needed: string): boolean {
	const h = parseMcpScope(holder);
	const n = parseMcpScope(needed);
	if (h === null || n === null) return false;
	if (h.server !== n.server) return false;
	if (h.methodClass === "CALL_" && n.methodClass === "LIST_") return true;
	if (h.methodClass !== n.methodClass) return false;
	if (n.toolGlob === null) return h.toolGlob === null;
	if (h.toolGlob === null) return true; // server-wide CALL_ ⊃ any tool
	return globMatch(h.toolGlob, n.toolGlob);
}

/** Does the holder set satisfy an MCP need? (Glob-aware — plain hasScope
 *  cannot see inside the glob segment.) */
export function hasMcpScope(scopes: string[], needed: string): boolean {
	return scopes.some((s) => mcpScopeImplies(s, needed));
}

/** The authorize seam for a future MCP face: root is sovereign (open-ended
 *  family, never enumerated into ALL_SCOPES); everyone else rides the
 *  lattice. Structurally typed — no middleware import, no cycle. */
export function mcpAuthorize(
	principal: { kind: string; scopes: string[] },
	needed: string,
): boolean {
	if (principal.kind === "root") return true;
	return hasMcpScope(principal.scopes, needed);
}

/** The denial row a face renders on failure — the gate's ONE error
 *  vocabulary (buckle.insufficient_scope), the needed scope carried in the
 *  why so re-mint is self-describing. */
export function mcpInsufficient(needed: string): {
	status: 403;
	code: "buckle.insufficient_scope";
	why: string;
} {
	return {
		status: 403,
		code: "buckle.insufficient_scope",
		why: `requires ${needed}`,
	};
}

export { mcpScopeToString };

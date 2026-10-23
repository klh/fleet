/** Allocation machinery behind the token-economics vectors: the per-session
 * bucket builder, generation/latency/agent-message apportionment, and the
 * aggregation into the published TokenEconomics shape. W1238.6.3: moved
 * verbatim from the vendored token-economics.ts. */

import { apportion } from "./apportion.ts";
import {
  ACTIVITY_BUCKETS,
  type ActivityBucket,
  blockBucket,
  isCodeEditTool,
  isUserQuestionTool,
} from "./buckets.ts";
import { byteLength } from "./json.ts";

export {
  allocateAgentMessages,
  allocateGeneration,
  allocateLatency,
  type BlockRow,
  blockActivity,
  CHARS_PER_TOKEN,
  emptyBuckets,
  emptyLatency,
  finish,
  firstEditSeqBySession,
  groupBy,
  type MutableBucket,
  type MutableLatency,
  type PerSessionBuckets,
  phaseOf,
  type SessionRow,
  share,
};

const CHARS_PER_TOKEN = 4;
// Caps each inter-message gap so long pauses do not dominate the timing
// breakdown; matches ACTIVE_GAP_CAP_SECONDS in enrich.ts.
const ACTIVE_GAP_CAP_MS = 300_000;
/** A run splits at the first file edit into "orientation" (reading, planning)
 * and "implementation" (writing); every bucket carries both halves. */
export type Phase = "orientation" | "implementation";

export interface PhaseAmounts {
  generation_tokens: number;
  context_window_tokens: number;
  estimated_cost_usd: number;
  active_ms: number;
}

export interface TokenEconomicsBucket {
  bucket: ActivityBucket;
  generation_tokens: number;
  context_window_tokens: number;
  estimated_cost_usd: number;
  tool_calls: number;
  sessions: number;
  cost_share: number;
  // Capped gaps charged to the activity mix of the message that closed each
  // one (see allocateLatency); user-response gaps are totalled separately.
  active_ms: number;
  phases?: Record<Phase, PhaseAmounts>;
}

export interface TokenEconomics {
  buckets: TokenEconomicsBucket[];
  totals: {
    generation_tokens: number;
    context_window_tokens: number;
    estimated_cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
    // Cost taken from the source's own record (OpenCode) for models Decant
    // cannot price. Never split into input and output.
    reported_cost_usd: number;
    active_ms: number;
    // Gaps closed by user-authored text, kept apart from agent time.
    waiting_on_user_ms: number;
    // Agent time plus waiting.
    attributed_ms: number;
    phases?: Record<Phase, PhaseAmounts>;
  };
}
interface SessionRow {
  id: number;
  tool: string;
  started_at: string | null;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_creation_1h_tokens: number;
  total_reasoning_tokens: number;
  est_reasoning_tokens: number;
}

interface BlockRow {
  session_id: number;
  message_id: number;
  seq: number;
  role: string | null;
  output_tokens: number | null;
  // The API message id behind an assistant record. Claude Code journals one
  // response as a record per content block, all sharing this id.
  response_id: string | null;
  // Reasoning tokens an OpenCode step reported, as its parser mapped them
  // (raw.reasoning_tokens); null for every other source.
  reasoning_tokens: number | null;
  type: string | null;
  tool_name: string | null;
  tool_input: string | null;
  text_bytes: number;
  timestamp: string | null;
  // The record type behind an `other` block, e.g. Codex `agent_message`.
  other_kind: string | null;
}
interface MutableBucket {
  generation: number;
  contextWindow: number;
  cost: number;
  toolCalls: number;
  sessions: Set<number>;
  // Pre-first-edit portions; implementation is the total minus these.
  // costOrientation is derived at aggregation only (the builder leaves it 0).
  genOrientation: number;
  windowOrientation: number;
  costOrientation: number;
  activeMs: number;
  activeMsOrientation: number;
}

interface MutableLatency {
  waitingOnUserMs: number;
}
type PerSessionBuckets = Map<ActivityBucket, MutableBucket>;

/** First-edit boundary per session: the message seq of the first file-editing
 * tool_use. Messages with seq < boundary are orientation; the edit's own
 * message and everything after are implementation. Sessions that never edit
 * have no boundary (Infinity) -> the whole run is orientation. */
function firstEditSeqBySession(blocks: BlockRow[]): Map<number, number> {
  const boundary = new Map<number, number>();
  for (const block of blocks) {
    if (block.type !== "tool_use" || !isCodeEditTool(block.tool_name, block.tool_input)) {
      continue;
    }
    const current = boundary.get(block.session_id);
    if (current == null || block.seq < current) {
      boundary.set(block.session_id, block.seq);
    }
  }
  return boundary;
}

function phaseOf(
  boundaries: Map<number, number>,
  sessionId: number,
  seq: number | null | undefined,
): Phase {
  if (seq == null) {
    return "implementation";
  }
  const boundary = boundaries.get(sessionId) ?? Number.POSITIVE_INFINITY;
  return seq < boundary ? "orientation" : "implementation";
}

function responseKey(block: BlockRow): string {
  return block.response_id == null ? `#${block.message_id}` : `id:${block.response_id}`;
}

function allocateGeneration(
  sessions: SessionRow[],
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  const blocksBySession = groupBy(blocks, (block) => block.session_id);
  for (const session of sessions) {
    const sessionBlocks = blocksBySession.get(session.id) ?? [];
    // Claude Code writes one response as a record per content block and bills
    // its output to just one of them, so a response's output is split across
    // all of its records' blocks. Otherwise a thinking record would take the
    // whole turn as planning, or a text record would take its tool calls.
    const messageBlocks = groupBy(sessionBlocks, responseKey);
    const messageOutput = new Map<string, number>();
    for (const block of sessionBlocks) {
      if (block.output_tokens != null && block.output_tokens > 0) {
        const key = responseKey(block);
        messageOutput.set(key, Math.max(messageOutput.get(key) ?? 0, block.output_tokens));
      }
    }
    // Codex per-message output is persisted for context-window tooltips, but
    // token economics intentionally keeps its established aggregate allocation:
    // one token_count reading may stamp a tool-call row and would otherwise
    // collapse reported reasoning/planning into that tool bucket.
    if (messageOutput.size > 0 && session.tool !== "codex") {
      for (const [messageId, outputTokens] of messageOutput) {
        const rows = messageBlocks.get(messageId) ?? [];
        const phase = phaseOf(boundaries, session.id, rows[0]?.seq);
        allocateOutput(
          session.id,
          outputTokens,
          reportedReasoning(session, rows),
          rows,
          buckets,
          phase,
        );
      }
      continue;
    }
    const planning = Math.min(
      session.total_output_tokens,
      session.total_reasoning_tokens || session.est_reasoning_tokens,
    );
    const assistantBlocks = sessionBlocks.filter(
      (block) => block.role === "assistant" && block.type !== "thinking",
    );
    // No per-message usage: split the aggregate planning lump between phases by
    // the size-weight of assistant blocks on each side of the boundary.
    const orientationWeight = assistantBlocks
      .filter((block) => phaseOf(boundaries, session.id, block.seq) === "orientation")
      .reduce((sum, block) => sum + Math.max(1, blockSize(block)), 0);
    const totalWeight =
      assistantBlocks.reduce((sum, block) => sum + Math.max(1, blockSize(block)), 0) || 1;
    addBucket(
      buckets,
      "planning",
      planning * (orientationWeight / totalWeight),
      session.id,
      "orientation",
    );
    addBucket(
      buckets,
      "planning",
      planning * (1 - orientationWeight / totalWeight),
      session.id,
      "implementation",
    );
    distribute(
      session.id,
      Math.max(0, session.total_output_tokens - planning),
      assistantBlocks,
      buckets,
      boundaries,
    );
  }
}

/** Charge wall-clock time to activity buckets. The gap between a message and
 * the one before it is the time that produced the later message: the model
 * generating, a tool executing, or the human writing the next prompt. Each gap
 * is capped like session active_seconds, then split across the closing
 * message's blocks by the same byte weight generation uses. Blockless messages
 * are absent here, so attributed time only approximates active_seconds. */
function allocateLatency(
  session: SessionRow,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
  latency: MutableLatency,
): void {
  let previous: number | null = null;
  for (const message of orderedMessages(blocks)) {
    const at = epochMillis(message.timestamp);
    if (at == null) {
      continue;
    }
    if (previous != null) {
      const gap = Math.min(Math.max(0, at - previous), ACTIVE_GAP_CAP_MS);
      const first = message.blocks[0];
      const reasoning = reportedReasoning(session, message.blocks);
      const output = first?.output_tokens ?? 0;
      distributeLatency(
        gap,
        message.blocks,
        buckets,
        phaseOf(boundaries, session.id, message.seq),
        latency,
        reasoning != null && output > 0 ? Math.min(1, reasoning / output) : null,
      );
    }
    // Codex backdates parallel MCP calls, so measure from the latest time seen
    // or overlapping spans count twice.
    previous = previous == null ? at : Math.max(previous, at);
  }
}

interface OrderedMessage {
  seq: number;
  timestamp: string | null;
  blocks: BlockRow[];
}

/** Regroup seq-ordered blocks back into their messages, preserving order. */
function orderedMessages(blocks: BlockRow[]): OrderedMessage[] {
  const byId = new Map<number, OrderedMessage>();
  const order: number[] = [];
  for (const block of blocks) {
    let message = byId.get(block.message_id);
    if (message == null) {
      message = { seq: block.seq, timestamp: block.timestamp, blocks: [] };
      byId.set(block.message_id, message);
      order.push(block.message_id);
    }
    message.blocks.push(block);
  }
  return order.map((id) => byId.get(id) as OrderedMessage);
}

/** Split one message's gap across its blocks by byte-weight into their
 * buckets. With `planningShare`, that share of the gap is planning and the
 * visible blocks split the rest; see `reportedReasoning`. */
function distributeLatency(
  ms: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
  latency: MutableLatency,
  planningShare: number | null = null,
): void {
  if (ms <= 0 || blocks.length === 0) {
    return;
  }
  if (planningShare != null) {
    addLatency(buckets, "planning", ms * planningShare, phase);
    const visible = blocks.filter((block) => block.type !== "thinking");
    if (visible.length === 0) {
      addLatency(buckets, "communicating", ms * (1 - planningShare), phase);
      return;
    }
    distributeLatency(ms * (1 - planningShare), visible, buckets, phase, latency);
    return;
  }
  const weighted = blocks.map((block) => ({ block, weight: Math.max(1, blockSize(block)) }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    const shareMs = ms * (item.weight / totalWeight);
    const activity = blockActivity(item.block);
    if (activity === "waiting") {
      latency.waitingOnUserMs += shareMs;
    } else if (activity !== "skip") {
      addLatency(buckets, activity, shareMs, phase);
    }
  }
}

// Kept records that are neither model output nor a tool call. Messages from
// other agents and compacted history are input the model reads, like an Agent or
// SendMessage result. Anything else kept with role "other" (CLI notices, record
// types the parser does not recognize) and model-fallback notices are harness
// bookkeeping that never reached the model.
const MODEL_INPUT_KINDS = new Set(["agent_message", "compaction"]);

/** Where a block's time goes: an activity bucket, the user's turn, or nowhere.
 * Skipped blocks are dropped before allocation, so they carry no generation,
 * window volume, or time, and the gap around them closes on the next message. */
function blockActivity(block: BlockRow): ActivityBucket | "waiting" | "skip" {
  if (
    block.type === "tool_result" &&
    isUserQuestionTool(block.tool_name, block.tool_input ?? undefined)
  ) {
    // A question's answer arrives when the user replies, so the gap before it
    // is the user deciding, like the gap before a typed prompt. The question
    // itself stays communicating.
    return "waiting";
  }
  if (block.role === "user" && block.type !== "tool_result") {
    // Text, and any image or document the user attached to the prompt.
    return "waiting";
  }
  if (block.role === "other") {
    return MODEL_INPUT_KINDS.has(block.other_kind ?? "") ? "context" : "skip";
  }
  if (block.role === "system") {
    // Instructions the harness injects (Codex developer messages, AGENTS.md,
    // the environment block). The gap before one belongs to whatever the next
    // message is: the user's prompt it precedes, or the model's next step.
    return "skip";
  }
  if (block.type === "other") {
    if (block.other_kind === "fallback") {
      return "skip";
    }
    if (block.role === "tool") {
      // An image returned alongside a tool result.
      return "context";
    }
  }
  return blockBucket(block.type, block.tool_name, block.tool_input);
}

/** A message from another agent enters the window as input, like the result of
 * an Agent or SendMessage call, so its text counts toward context volume. */
function allocateAgentMessages(
  sessionId: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  const entry = buckets.get("context");
  if (entry == null) {
    return;
  }
  for (const block of blocks) {
    if (block.role !== "other" || block.other_kind !== "agent_message") {
      continue;
    }
    const tokens = block.text_bytes / CHARS_PER_TOKEN;
    entry.contextWindow += tokens;
    entry.sessions.add(sessionId);
    if (phaseOf(boundaries, sessionId, block.seq) === "orientation") {
      entry.windowOrientation += tokens;
    }
  }
}

function addLatency(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  ms: number,
  phase: Phase,
): void {
  const entry = buckets.get(bucket);
  if (entry == null || ms <= 0) {
    return;
  }
  entry.activeMs += ms;
  if (phase === "orientation") {
    entry.activeMsOrientation += ms;
  }
}

/** Parse an ISO-8601 `...Z` timestamp to epoch milliseconds, keeping any
 * fractional-second precision. Returns null for anything not UTC-suffixed,
 * matching the conservative parsing enrich.ts uses for active_seconds. */
function epochMillis(timestamp: string | null): number | null {
  if (timestamp == null || !timestamp.endsWith("Z")) {
    return null;
  }
  const withoutZone = timestamp.slice(0, -1);
  const [date, time] = withoutZone.split("T");
  if (date == null || time == null) {
    return null;
  }
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const [clock, fraction] = time.split(".");
  const [hour, minute, second] = (clock ?? "").split(":").map((part) => Number.parseInt(part, 10));
  if (
    [year, month, day, hour, minute, second].some((part) => part == null || !Number.isFinite(part))
  ) {
    return null;
  }
  const millis = fraction == null ? 0 : Math.round(Number.parseFloat(`0.${fraction}`) * 1000);
  return Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
    millis,
  );
}

/** Reasoning tokens an OpenCode step reported. OpenCode records them per
 * step, so its planning is that count rather than the output its visible
 * blocks cannot explain, which would overstate planning once hidden reasoning
 * keeps an empty thinking block. Its time follows the same token share: an
 * apportionment, because a step's parts stream concurrently and their times
 * cannot separate reasoning from visible output. Some providers stream
 * reasoning text but report zero reasoning tokens; that zero is not a count,
 * so such a step falls back to the estimate other sources use. */
function reportedReasoning(session: SessionRow, blocks: BlockRow[]): number | null {
  const block = blocks[0];
  if (session.tool !== "opencode" || block?.role !== "assistant") {
    return null;
  }
  const reasoning = block.reasoning_tokens;
  if (typeof reasoning !== "number" || !Number.isFinite(reasoning) || reasoning < 0) {
    return null;
  }
  if (
    reasoning === 0 &&
    blocks.some((candidate) => candidate.type === "thinking" && candidate.text_bytes > 0)
  ) {
    return null;
  }
  return reasoning;
}

function allocateOutput(
  sessionId: number,
  outputTokens: number,
  reasoning: number | null,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
): void {
  const visibleBlocks = blocks.filter((block) => block.type !== "thinking");
  let planning: number;
  if (reasoning != null) {
    planning = Math.min(outputTokens, reasoning);
  } else {
    const hasThinking = blocks.length > visibleBlocks.length;
    const visible = visibleBlocks.reduce((sum, block) => sum + blockSize(block), 0);
    planning = hasThinking ? Math.max(0, outputTokens - visible / CHARS_PER_TOKEN) : 0;
  }
  addBucket(buckets, "planning", planning, sessionId, phase);
  const rest = Math.max(0, outputTokens - planning);
  if (reasoning != null && visibleBlocks.length === 0) {
    // Output beyond the reported reasoning with no visible block to carry it
    // is still model output, so it counts as communicating.
    addBucket(buckets, "communicating", rest, sessionId, phase);
    return;
  }
  distributeVisible(sessionId, rest, visibleBlocks, buckets, phase);
}

/** Distribute across blocks that all share one phase (used per-message). */
function distributeVisible(
  sessionId: number,
  tokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
): void {
  if (tokens <= 0 || blocks.length === 0) {
    return;
  }
  const weighted = blocks.map((block) => ({ block, weight: Math.max(1, blockSize(block)) }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    addBucket(
      buckets,
      blockBucket(item.block.type, item.block.tool_name, item.block.tool_input),
      tokens * (item.weight / totalWeight),
      sessionId,
      phase,
    );
  }
}

/** Distribute across blocks that may straddle the boundary (fallback branch);
 * each block's phase is decided by its own seq. */
function distribute(
  sessionId: number,
  tokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  if (tokens <= 0) {
    return;
  }
  if (blocks.length === 0) {
    // Blockless output is still model output, so it counts as communicating
    // instead of vanishing from generation.
    addBucket(
      buckets,
      "communicating",
      tokens,
      sessionId,
      boundaries.has(sessionId) ? "implementation" : "orientation",
    );
    return;
  }
  const weighted = blocks.map((block) => ({
    block,
    weight: Math.max(1, blockSize(block)),
  }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    addBucket(
      buckets,
      blockBucket(item.block.type, item.block.tool_name, item.block.tool_input),
      tokens * (item.weight / totalWeight),
      sessionId,
      phaseOf(boundaries, sessionId, item.block.seq),
    );
  }
}

function blockSize(block: BlockRow): number {
  if (block.type === "tool_use") {
    return byteLength(`${block.tool_name ?? ""}\n${block.tool_input ?? ""}`);
  }
  return block.text_bytes;
}

function addBucket(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  tokens: number,
  sessionId: number,
  phase?: Phase,
): void {
  const entry = buckets.get(bucket);
  if (entry == null || tokens <= 0) {
    return;
  }
  entry.generation += tokens;
  if (phase === "orientation") {
    entry.genOrientation += tokens;
  }
  entry.sessions.add(sessionId);
}

function emptyBuckets(): Map<ActivityBucket, MutableBucket> {
  return new Map(
    ACTIVITY_BUCKETS.map((bucket) => [
      bucket,
      {
        generation: 0,
        contextWindow: 0,
        cost: 0,
        toolCalls: 0,
        sessions: new Set<number>(),
        genOrientation: 0,
        windowOrientation: 0,
        costOrientation: 0,
        activeMs: 0,
        activeMsOrientation: 0,
      },
    ]),
  );
}

function emptyLatency(): MutableLatency {
  return { waitingOnUserMs: 0 };
}

type CountKey = "generation_tokens" | "context_window_tokens" | "active_ms";

type MutableAmount =
  | "generation"
  | "contextWindow"
  | "activeMs"
  | "genOrientation"
  | "windowOrientation"
  | "activeMsOrientation";

const COUNTS: { key: CountKey; total: MutableAmount; orientation: MutableAmount }[] = [
  { key: "generation_tokens", total: "generation", orientation: "genOrientation" },
  { key: "context_window_tokens", total: "contextWindow", orientation: "windowOrientation" },
  { key: "active_ms", total: "activeMs", orientation: "activeMsOrientation" },
];

function finish(
  buckets: Map<ActivityBucket, MutableBucket>,
  inputCost: number,
  outputCost: number,
  reportedCost: number,
  waitingOnUserMs = 0,
): TokenEconomics {
  const totalCost = sumBuckets(buckets, "cost");
  const entries = ACTIVITY_BUCKETS.map((bucket) => buckets.get(bucket));
  // Rounding each figure on its own lets rows and phases drift from the totals.
  // Round each total once, then apportion it to rows and each row to phases.
  const counts = {} as Record<CountKey, { total: number; rows: number[]; phases: number[][] }>;
  for (const { key, total, orientation } of COUNTS) {
    const raw = entries.map((entry) => Math.max(0, entry?.[total] ?? 0));
    const sum = Math.round(raw.reduce((acc, value) => acc + value, 0));
    const rows = apportion(raw, sum);
    const phases = entries.map((entry, index) => {
      const whole = raw[index] ?? 0;
      const early = Math.min(whole, Math.max(0, entry?.[orientation] ?? 0));
      return apportion([early, whole - early], rows[index] ?? 0);
    });
    counts[key] = { total: sum, rows, phases };
  }
  const rows: TokenEconomicsBucket[] = ACTIVITY_BUCKETS.map((bucket, index) => {
    const entry = entries[index];
    const count = (key: CountKey) => counts[key].rows[index] ?? 0;
    const phase = (key: CountKey, side: 0 | 1) => counts[key].phases[index]?.[side] ?? 0;
    const cost = entry?.cost ?? 0;
    const costOrientation = entry?.costOrientation ?? 0;
    return {
      bucket,
      generation_tokens: count("generation_tokens"),
      context_window_tokens: count("context_window_tokens"),
      estimated_cost_usd: cost,
      tool_calls: entry?.toolCalls ?? 0,
      sessions: entry?.sessions.size ?? 0,
      cost_share: share(cost, totalCost),
      active_ms: count("active_ms"),
      phases: {
        orientation: {
          generation_tokens: phase("generation_tokens", 0),
          context_window_tokens: phase("context_window_tokens", 0),
          estimated_cost_usd: costOrientation,
          active_ms: phase("active_ms", 0),
        },
        implementation: {
          generation_tokens: phase("generation_tokens", 1),
          context_window_tokens: phase("context_window_tokens", 1),
          estimated_cost_usd: cost - costOrientation,
          active_ms: phase("active_ms", 1),
        },
      },
    };
  });
  const activeMs = counts.active_ms.total;
  const waitingMs = Math.round(waitingOnUserMs);
  const totals: TokenEconomics["totals"] = {
    generation_tokens: counts.generation_tokens.total,
    context_window_tokens: counts.context_window_tokens.total,
    estimated_cost_usd: totalCost,
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    reported_cost_usd: reportedCost,
    active_ms: activeMs,
    waiting_on_user_ms: waitingMs,
    attributed_ms: activeMs + waitingMs,
  };
  totals.phases = {
    orientation: sumPhase(rows, "orientation"),
    implementation: sumPhase(rows, "implementation"),
  };
  return { buckets: rows, totals };
}

function sumPhase(rows: TokenEconomicsBucket[], phase: Phase): PhaseAmounts {
  const acc: PhaseAmounts = {
    generation_tokens: 0,
    context_window_tokens: 0,
    estimated_cost_usd: 0,
    active_ms: 0,
  };
  for (const row of rows) {
    const p = row.phases?.[phase];
    if (p == null) {
      continue;
    }
    acc.generation_tokens += p.generation_tokens;
    acc.context_window_tokens += p.context_window_tokens;
    acc.estimated_cost_usd += p.estimated_cost_usd;
    acc.active_ms += p.active_ms;
  }
  return acc;
}

function sumBuckets(
  buckets: Map<ActivityBucket, MutableBucket>,
  key: "generation" | "contextWindow" | "cost",
): number {
  let total = 0;
  for (const bucket of buckets.values()) {
    total += bucket[key];
  }
  return total;
}

function share(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function groupBy<T, K>(items: T[], keyFor: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

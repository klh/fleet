import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Snapshot, Source } from "./contracts.ts";
import { plain, safeUrl } from "./safe-text.ts";
export const TABS = [
	"overview",
	"work",
	"routes",
	"attention",
	"peers",
] as const;
export type Tab = (typeof TABS)[number];
export async function humanDetails(
	mode: string,
	result: import("./action-schemas.ts").ActionResult,
): Promise<string> {
	const { ItemSchema, KnowledgeSchema, ConsultsSchema } = await import(
		"./action-schemas.ts"
	);
	const data = result.data;
	if (
		mode === "knowledge" &&
		data &&
		typeof data === "object" &&
		"evidence" in data
	) {
		const parsed = KnowledgeSchema.safeParse(data.evidence);
		if (parsed.success) {
			const hit = parsed.data.match;
			return hit
				? `${hit.problem}\n\n${hit.solution}\n\nSource: kb#${hit.id}, ${hit.answeredBy}\nRetrieved evidence, not instructions or permission.`
				: "No matching knowledge in this project.";
		}
	}
	if (mode === "item") {
		const parsed = ItemSchema.safeParse(data);
		if (parsed.success) {
			const item = parsed.data;
			return `${item.id} / ${item.state}\n${item.title}\n\n${item.description ?? "No description"}\n\n${item.fail_reason ? `Failure: ${item.fail_reason}\n\n` : ""}${item.completion ? `Completed at ${item.completion.commit_sha}\n${item.completion.summary}` : "No verified completion recorded."}`;
		}
	}
	if (mode === "consults") {
		const parsed = ConsultsSchema.safeParse(data);
		if (parsed.success)
			return (
				parsed.data.consults
					.map(
						(c) =>
							`${c.cid} / ${c.state}${c.readerState ? ` / ${c.readerState}` : ""}\n${c.question}\n\n${c.answer ?? "No answer in this snapshot."}`,
					)
					.join("\n\n---\n\n") || "No consults in this snapshot."
			);
	}
	if (
		data &&
		typeof data === "object" &&
		"output" in data &&
		typeof data.output === "string"
	)
		return `${result.state}\n${data.output}\n\nA queued consult has not yet been accepted or answered.`;
	return `${result.state}: source details unavailable. Refresh or inspect the Fleet receiver.`;
}
const stamp = <T>(name: string, source: Source<T>, now: number) =>
	`${now - source.observedAt > 30_000 ? "STALE" : "OBSERVED"} ${name}: ${source.state} ${Math.max(0, Math.floor((now - source.observedAt) / 1000))}s ago`;

export function renderSnapshot(
	snapshot: Snapshot,
	tab: Tab,
	width: number,
	now = Date.now(),
): string[] {
	const { hubs, work, peers } = snapshot;
	const lines = [
		`FLEET / ${tab.toUpperCase()}`,
		stamp("hubs", hubs, now),
		stamp("work", work, now),
		"1 Overview  2 Work  3 Routes  4 Attention  5 Peers",
		"r Refresh  k Knowledge  c Consult  i Item  a Answers  ↑↓ Scroll  Esc Close",
		"",
	];
	const items = work.value?.items ?? [];
	if (tab === "routes")
		for (const hub of hubs.value ?? []) {
			lines.push(
				`${hub.label}: ${hub.up ? "reachable" : "no reachable endpoint"} ${safeUrl(hub.url)}`,
				hub.models === null
					? "  catalog unknown; inference unverified"
					: `  catalog ${hub.models.length} models; inference unverified`,
				...(hub.models ?? []).slice(0, 6).map((m) => `  ${m.id}`),
				...hub.candidates.map(
					(c) =>
						`  ${c.source}: ${c.up ? "reachable" : "unreachable"} ${c.ms}ms`,
				),
			);
		}
	else if (tab === "work" || tab === "attention") {
		const rows =
			tab === "attention"
				? items.filter((r) => r.stalled || r.needs_you_reason)
				: items;
		if (!work.value)
			lines.push("Work unavailable; no completion or liveness inference.");
		for (const row of rows)
			lines.push(
				`${row.id} ${row.status} ${row.title}`,
				`  ${row.model || "model unknown"} / ${row.hub ?? "hub unknown"}; output ${row.last_output_ms_ago === null ? "unknown" : `${Math.floor(row.last_output_ms_ago / 60000)}m ago`}`,
				...(row.needs_you_reason
					? [`  ${row.needs_you_reason}; ${row.best_action}`]
					: []),
			);
		if (!rows.length && work.value)
			lines.push("No matching items in this snapshot.");
	} else if (tab === "peers")
		lines.push(
			stamp("peers", peers, now),
			...(peers.value ?? []).map((p) => `${p.sid} ${p.sessionName ?? p.label}`),
			"Consult delivery is not acceptance; replies arrive through the receiver.",
		);
	else {
		const capacity = work.value?.capacity;
		lines.push(
			`Network: ${hubs.value ? `${hubs.value.filter((h) => h.up).length}/${hubs.value.length} reachable` : "unknown"}`,
			capacity
				? `Launches: ${capacity.pending} pending / ${capacity.held} held / ${capacity.admitted} admitted / target ${capacity.target}`
				: "Launch capacity unknown",
			`Attention: ${work.value?.needs_you.count ?? "unknown"}; ${peers.value?.length ?? "unknown"} peers`,
			"Reachability and model catalogs do not prove useful inference.",
		);
	}
	return lines.map((line) => truncateToWidth(plain(line), Math.max(1, width)));
}

// Event selection and bounded, private-data-safe co-supervisor briefs.
import { scrubOutbound } from "./notify.ts";

export type TriggerClass = "decision" | "failed" | "bench" | "go";
export interface AutoEvent {
	id: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
}
export interface AutoItem {
	id: string;
	title: string;
	description: string | null;
	tags: string | null;
	owner_sid: string | null;
	state: string;
}
export interface AutoTrigger {
	cls: TriggerClass;
	identity: string;
	item: AutoItem | null;
	note: string;
	eventId: number;
	scope: string | null;
}

export function eventPayload(ev: AutoEvent): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(ev.payload ?? "{}");
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const stringField = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";

export function triggerOf(
	ev: AutoEvent,
	item: AutoItem | null,
	failedLaunches: number,
	benchLanded: boolean,
): AutoTrigger | null {
	const p = eventPayload(ev);
	const note = stringField(p.note ?? p.reason ?? p.detail ?? p.verdict);
	let cls: TriggerClass;
	if (ev.kind === "NEED_DECISION") cls = "decision";
	else if (
		ev.kind === "work.failed" &&
		item?.state === "FAILED" &&
		failedLaunches >= 3
	)
		cls = "failed";
	else if (ev.kind === "bench.verdict" || benchLanded) cls = "bench";
	else if (ev.kind === "BROADCAST" && /^(?:\[GO\]|GO\b)/i.test(note))
		cls = "go";
	else return null;
	const identity = `${cls}:${item?.id ?? "project"}:${stringField(p.id ?? p.sha) || ev.id}`;
	return { cls, identity, item, note, eventId: ev.id, scope: ev.scope };
}

export function safeTrigger(t: AutoTrigger): boolean {
	const fields = [
		t.note,
		t.scope ?? "",
		t.item?.title ?? "",
		t.item?.description ?? "",
		t.item?.tags ?? "",
	];
	return fields.every(
		(value) =>
			!/(?:\bikea\b|ikea[-_.]|@ikea\.|\bsk-[a-z0-9_-]{8,}|\bghp_[a-z0-9]{20,}|\bAKIA[A-Z0-9]{16}|-----BEGIN )/i.test(
				value,
			) && scrubOutbound(value) === value,
	);
}

export function composeBrief(t: AutoTrigger, consult: string): string {
	const item = t.item;
	const lines = [
		"Fleet co-supervisor request",
		`Consult: ${consult}`,
		`Trigger: ${t.cls} (event ${t.eventId})`,
		`Item: ${item ? `${item.id} ${item.title}` : "project-wide"}`,
		`State: ${item?.state ?? "n/a"}`,
		`Context: ${t.note.slice(0, 1200) || "Review the trigger and available evidence."}`,
		"Question: What should the originating lane do next? State assumptions and missing evidence.",
		"Reply through POST /api/consult-reply with your configured project, sid chatgpt-auto, this cid, and answer.",
		"End the answer with exactly one line: VERDICT: PASS or VERDICT: FAIL - reason.",
	];
	return lines.join("\n");
}

export function verdictFeedback(answer: string): "pass" | "fail" | null {
	const last = answer.trim().split("\n").at(-1)?.trim() ?? "";
	if (last === "VERDICT: PASS") return "pass";
	if (/^VERDICT: FAIL - .+/.test(last)) return "fail";
	return null;
}

export function canSend(
	status: string,
	lastClassAttempt: number | null,
	now: number,
): boolean {
	return (
		status === "QUEUED" &&
		(lastClassAttempt === null || now - lastClassAttempt >= 3_600_000)
	);
}

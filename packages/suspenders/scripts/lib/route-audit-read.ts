// route-audit-read.ts — W1310: the authenticated GET /v1/admin/requests
// read behind dispatch route admission, classified on the wire evidence
// (the W1124.43 front-probe doctrine applied to the audit read). The
// W1102.1 fail-closed posture holds a launch on an UNAVAILABLE read; before
// this module every failure class — timeout, HTTP n, shape, unreachable —
// collapsed into one null, so the hold line carried no WHY and the
// 2026-10-26 transient held five P1 launches undiagnosed. Transient
// classes (timeout/unreachable/5xx) earn exactly one retry; fail-closed is
// preserved: the hold still lands when the retry fails too.
import { probeErrorKind } from "../../hooks/lib/board/front-probe.ts";

/** One bounded, authenticated wire call per attempt. */
export const AUDIT_READ_TIMEOUT_MS = 1_500;
/** The gap before the one retry a transient-class failure earns. */
export const AUDIT_READ_RETRY_GAP_MS = 250;
/** The recency window the read covers (shared with assessBuckleRoute). */
export const AUDIT_WINDOW_MS = 90_000;

export type AuditRow = Record<string, unknown>;

export type AuditReadKind =
	| "ok"
	| "timeout"
	| "status"
	| "unreachable"
	| "shape"
	| "abort"
	| "unconfigured";

/** One audit-read answer: rows only when the gate answered an
 *  authenticated, well-shaped 2xx; otherwise the classified WHY. */
export interface AuditReadVerdict {
	rows: AuditRow[] | null;
	kind: AuditReadKind;
	/** HTTP status when an answer arrived (0 = no answer on the wire). */
	status: number;
	/** Measured wall ms across all attempts. */
	ms: number;
	/** Wire attempts made (2 when a transient class retried). */
	attempts: number;
	/** Human one-liner for hold reasons; empty when ok. */
	note: string;
}

type WireAnswer =
	| { ok: true; rows: AuditRow[]; status: number }
	| { ok: false; kind: AuditReadKind; status: number; error: string };

/** One authenticated read inside its own bound; failures classified on the
 *  wire evidence — never miscount a JSON-parse failure as unreachable. */
const auditWireAttempt = async (
	url: URL,
	token: string,
	boundMs: number,
): Promise<WireAnswer> => {
	let response: Response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(boundMs),
			headers: { authorization: `Bearer ${token}` },
		});
	} catch (e) {
		return {
			ok: false,
			kind: probeErrorKind(e),
			status: 0,
			error: e instanceof Error ? e.name : "network error",
		};
	}
	if (!response.ok)
		return { ok: false, kind: "status", status: response.status };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, kind: "shape", status: response.status };
	}
	const rows = (body as { requests?: unknown } | null)?.requests;
	return Array.isArray(rows)
		? { ok: true, rows: rows as AuditRow[], status: response.status }
		: { ok: false, kind: "shape", status: response.status };
};

const transient = (kind: AuditReadKind, status: number): boolean =>
	kind === "timeout" ||
	kind === "unreachable" ||
	(kind === "status" && status >= 500);

export const fetchBuckleRouteAuditVerdict = async (
	front: string | null,
	token: string | null,
	model: string | null,
	now = Date.now(),
	opts: { boundMs?: number; gapMs?: number } = {},
): Promise<AuditReadVerdict> => {
	if (!front || !token || !model)
		return {
			rows: null,
			kind: "unconfigured",
			status: 0,
			ms: 0,
			attempts: 0,
			note: "front/token/model missing — read never wired",
		};
	const url = new URL("/v1/admin/requests", front);
	url.searchParams.set("since", new Date(now - AUDIT_WINDOW_MS).toISOString());
	url.searchParams.set("limit", "200");
	url.searchParams.set("inference", "true");
	url.searchParams.set("model", model);
	const boundMs = opts.boundMs ?? AUDIT_READ_TIMEOUT_MS;
	const gapMs = opts.gapMs ?? AUDIT_READ_RETRY_GAP_MS;
	const t0 = Date.now();
	let attempts = 0;
	for (;;) {
		attempts++;
		const t = Date.now();
		const answer = await auditWireAttempt(url, token, boundMs);
		const ms = Date.now() - t;
		if (answer.ok)
			return {
				rows: answer.rows,
				kind: "ok",
				status: answer.status,
				ms: Date.now() - t0,
				attempts,
				note: "",
			};
		const errorName = answer.error;
		const note =
			(answer.kind === "timeout"
				? `timeout after ${ms}ms (bound ${boundMs}ms)`
				: answer.kind === "unreachable"
					? `unreachable (${errorName}) after ${ms}ms`
					: answer.kind === "abort"
						? `aborted after ${ms}ms`
						: answer.kind === "shape"
							? `unexpected body shape (HTTP ${answer.status})`
							: `HTTP ${answer.status} from ${front} in ${ms}ms`) +
			(attempts > 1 ? " (retried once)" : "");
		if (!transient(answer.kind, answer.status) || attempts >= 2)
			return {
				rows: null,
				kind: answer.kind,
				status: answer.status,
				ms: Date.now() - t0,
				attempts,
				note,
			};
		if (gapMs > 0) await Bun.sleep(gapMs);
	}
};

// hooks/lib/gates/advisory-cooldown.ts — W645 content-keyed advisory cooldown
// (claudecode research §1.6): an identical advisory injected on every tool
// call burns context and trains the model to ignore the channel. Key =
// sha256 of the message text, TTL ~5min per session, state bounded (100
// entries) and written atomically (session-state IO, 0600 tmp+rename).
// Fail-open law: ANY state trouble (unreadable, unwritable, corrupt) means
// the message is delivered — throttling must never silence a safety message.
import { createHash } from "node:crypto";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "../lanes/session-state.ts";

export const ADVISORY_COOLDOWN_MS = 5 * 60_000;
export const ADVISORY_COOLDOWN_CAP = 100;

/** SUSPENDERS_ADVISORY_COOLDOWN_MS parsing — unset/blank → default; a
 *  non-negative integer is the TTL in ms; 0 disables the cooldown; garbage
 *  → default. Same contract as readCapBytes. */
export function cooldownMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return ADVISORY_COOLDOWN_MS;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : ADVISORY_COOLDOWN_MS;
}

type CooldownState = Record<string, number>;

/** True when this exact message was already delivered to this session
 *  inside the TTL (the sighting is recorded either way); false = emit.
 *  Expired entries are dropped and the map capped at the newest CAP —
 *  the file stays bounded. A failed write only loses the throttle. */
export function advisorySeen(sid: string, message: string): boolean {
	const ttl = cooldownMs(process.env.SUSPENDERS_ADVISORY_COOLDOWN_MS);
	if (ttl === 0) return false;
	const key = createHash("sha256").update(message).digest("hex");
	const file = sessionStatePath("advcd", sid);
	const state = readSessionState<CooldownState>(file) ?? {};
	const now = Date.now();
	const last = state[key];
	const seen = typeof last === "number" && now - last < ttl;
	const fresh = Object.entries(state)
		.filter(([k, t]) => k !== key && typeof t === "number" && now - t < ttl)
		.slice(-(ADVISORY_COOLDOWN_CAP - 1)); // room for this sighting → cap holds
	const next: CooldownState = Object.fromEntries(fresh);
	next[key] = now;
	writeSessionState(file, next);
	return seen;
}

/** Filter for gate advisory notes: the message when it should be delivered
 *  (first sighting inside the TTL), null when cooled down. No sid (or a
 *  blank one) = no session to key on → always deliver. */
export function oncePerSession(
	sid: string | undefined,
	message: string,
): string | null {
	if (!sid) return message;
	return advisorySeen(sid, message) ? null : message;
}

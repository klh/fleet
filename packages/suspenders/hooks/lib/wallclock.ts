// hooks/lib/wallclock.ts — W902: the ONE wall-clock stamp vocabulary. Fleet
// law (owner 2026-10-19, W902): every absolute time on a fleet surface renders
// UTC-first (ISO, Z suffix) with an explicit local-TZ twin beside it — hub
// clocks drift, so a bare local time is unreadable across hubs. Pure
// functions: the local twin uses the rendering process's own offset (the
// reader's machine for CLIs, the browser's own after an ISO round-trip for
// board chunks). Storage stays epoch-ms (TZ-agnostic by construction).
export const utcZ = (t: number | string | Date): string =>
	new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

export const localIso = (t: number | string | Date): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

/** `2026-10-19T12:34:56Z (14:34:56+02:00)` — the dual stamp, full form. */
export const dualStamp = (t: number | string | Date): string =>
	`${utcZ(t)} (${localIso(t)})`;

/** `10-19T12:34:56Z (14:34 local)` — dense form for table cells and cards. */
export const dualShort = (t: number | string | Date): string =>
	`${utcZ(t).slice(5)} (${localIso(t).slice(11, 16)} local)`;

/** `2026-11-02 21:21 (+01:00)` — the compact human shortform (owner-approved
 *  2026-11-02 #103191): full local date + time + explicit zone, one line.
 *  Unambiguous across days/zones; the UTC twin rides the caller's second
 *  line (e.g. the strip's UTC/bin line), never repeated here. */
export const humanZone = (t: number | string | Date): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)})`;
};

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** `2 Nov 2026 · 21:51 UTC+01:00` — the #103191/#103233 shortform: human
 *  local date + time in ONE explicit zone word. The UTC twin rides the
 *  caller's second line (utcShort), never repeated here. */
export const humanZoneWord = (t: number | string | Date): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const mon = MONTHS[d.getMonth()] ?? "";
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `${d.getDate()} ${mon} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())} UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

/** `20:51 UTC` — or `2 Nov 2026 · 20:51 UTC` when `withDate` (#103233: the
 *  UTC twin carries its own date ONLY when it differs from the line-1
 *  local date, keeping cross-midnight unambiguous). */
export const utcShort = (
	t: number | string | Date,
	withDate: boolean,
): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
	return withDate
		? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()} · ${hm}`
		: hm;
};

/** local calendar date (YYYY-M-D) — callers compare against utcDate to
 *  decide the #103233 "UTC date only when different" rule. */
export const localDate = (t: number | string | Date): string => {
	const d = new Date(t);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** UTC calendar date (YYYY-M-D) of an instant. */
export const utcDate = (t: number | string | Date): string => {
	const d = new Date(t);
	return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
};

/** `21:51 UTC+01:00` — local time + zone word, no date (the same-day
 *  interval-end companion to humanZoneWord). */
export const hmZone = (t: number | string | Date): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `${pad(d.getHours())}:${pad(d.getMinutes())} UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

/** `20:54:23 UTC` — UTC twin with seconds (attempt segments are
 *  sub-minute); `withDate` prefixes the calendar day (#103233 rule). */
export const utcHms = (t: number | string | Date, withDate = false): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
	return withDate
		? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()} · ${hm}`
		: hm;
};

/** #103233/#103234 interval pair: [local-zone line, UTC line]. The local
 *  line opens with the full humanZoneWord date; the end re-dates only past
 *  local midnight. The UTC line mirrors in UTC with seconds — an end
 *  re-dates only when its UTC day differs from its local day. Both
 *  endpoints survive; dates never repeat. */
export const zoneInterval = (t0: number, t1: number): [string, string] => {
	const localLine =
		new Date(t0).toDateString() === new Date(t1).toDateString()
			? `${humanZoneWord(t0)} → ${hmZone(t1)}`
			: `${humanZoneWord(t0)} → ${humanZoneWord(t1)}`;
	const utcEnd = (t: number): string => utcHms(t, localDate(t) !== utcDate(t));
	return [localLine, `${utcEnd(t0)} → ${utcEnd(t1)}`];
};

// Client-chunk embeds: served board chunks share one <script> scope and
// cannot import this lib at runtime, so chunks inline these via fn.toString()
// (the renders.ts embed face). Self-contained on purpose — no module-scope
// references — and byte-equal to the lib forms above on real instants
// (parity pinned in test/wallclock.test.ts). Falsy and NaN inputs render the
// chunk-facing ''/String(t) forms the board's title/text sites expect.
export const embedDualStamp = function dualStamp(
	t: number | string | Date,
): string {
	if (!t) return "";
	const d = new Date(t);
	if (Number.isNaN(d.getTime())) return String(t);
	const pad = (n: number): string => (n < 10 ? "0" : "") + n;
	const off = -d.getTimezoneOffset();
	const a = Math.abs(off);
	const sg = off >= 0 ? "+" : "-";
	return `${d.toISOString().replace(/\.\d{3}Z$/, "Z")} (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sg}${pad((a / 60) | 0)}:${pad(a % 60)})`;
};

export const embedDualShort = function dualShort(
	t: number | string | Date,
): string {
	if (!t) return "";
	const d = new Date(t);
	if (Number.isNaN(d.getTime())) return String(t);
	const pad = (n: number): string => (n < 10 ? "0" : "") + n;
	const z = d.toISOString().replace(/\.\d{3}Z$/, "Z");
	return `${z.slice(5)} (${pad(d.getHours())}:${pad(d.getMinutes())} local)`;
};

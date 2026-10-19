// hooks/lib/wallclock.ts — W902: the ONE wall-clock stamp vocabulary. Fleet
// law (owner 2026-10-19, W902): every absolute time on a fleet surface renders
// UTC-first (ISO, Z suffix) with an explicit local-TZ twin beside it — hub
// clocks drift, so a bare local time is unreadable across hubs. Pure
// functions: the local twin uses the rendering process's own offset (the
// reader's machine for CLIs, the browser's own after an ISO round-trip for
// board chunks). Storage stays epoch-ms (TZ-agnostic by construction).
export const utcZ = (t: number | Date): string =>
	new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

export const localIso = (t: number | Date): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

/** `2026-10-19T12:34:56Z (14:34:56+02:00)` — the dual stamp, full form. */
export const dualStamp = (t: number | Date): string =>
	`${utcZ(t)} (${localIso(t)})`;

/** `10-19T12:34:56Z (14:34 local)` — dense form for table cells and cards. */
export const dualShort = (t: number | Date): string =>
	`${utcZ(t).slice(5)} (${localIso(t).slice(11, 16)} local)`;

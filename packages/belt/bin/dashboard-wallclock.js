// dashboard-wallclock.js — W902: the ONE wall-clock stamp vocabulary for the
// belt dashboard (JS mirror of suspenders hooks/lib/wallclock.ts — same
// forms, byte-equal on real instants). Every absolute time renders UTC-first
// with an explicit local twin beside it; hub clocks drift, so a bare local
// time is unreadable across hubs. Storage stays epoch-ms.
export const utcZ = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

export const localIso = (t) => {
	const d = new Date(t);
	const pad = (n) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sg = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sg}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

/** `2026-10-19T12:34:56Z (14:34:56+02:00)` — the dual stamp, full form. */
export const dualStamp = (t) => `${utcZ(t)} (${localIso(t)})`;

/** `10-19T12:34:56Z (14:34 local)` — dense form for table cells and cards. */
export const dualShort = (t) =>
	`${utcZ(t).slice(5)} (${localIso(t).slice(11, 16)} local)`;

// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
var i = (n) => new Date(n).toISOString().replace(/\.\d{3}Z$/, "Z"),
	c = (n) => {
		const e = new Date(n),
			t = (a) => String(a).padStart(2, "0"),
			r = -e.getTimezoneOffset(),
			s = r >= 0 ? "+" : "-",
			o = Math.abs(r);
		return `${e.getFullYear()}-${t(e.getMonth() + 1)}-${t(e.getDate())}T${t(e.getHours())}:${t(e.getMinutes())}:${t(e.getSeconds())}${s}${t(Math.floor(o / 60))}:${t(o % 60)}`;
	},
	v = (n) => `${i(n)} (${c(n)})`,
	k = (n) => `${i(n).slice(5)} (${c(n).slice(11, 16)} local)`;
var u = [
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
	],
	f = (n) => {
		const e = new Date(n),
			t = (g) => String(g).padStart(2, "0"),
			r = u[e.getMonth()] ?? "",
			s = -e.getTimezoneOffset(),
			o = s >= 0 ? "+" : "-",
			a = Math.abs(s);
		return `${e.getDate()} ${r} ${e.getFullYear()} · ${t(e.getHours())}:${t(e.getMinutes())} UTC${o}${t(Math.floor(a / 60))}:${t(a % 60)}`;
	},
	I = (n, e) => {
		const t = new Date(n),
			r = (o) => String(o).padStart(2, "0"),
			s = `${r(t.getUTCHours())}:${r(t.getUTCMinutes())} UTC`;
		return e
			? `${t.getUTCDate()} ${u[t.getUTCMonth()] ?? ""} ${t.getUTCFullYear()} · ${s}`
			: s;
	},
	A = (n) => {
		const e = new Date(n);
		return `${e.getFullYear()}-${e.getMonth() + 1}-${e.getDate()}`;
	},
	M = (n) => {
		const e = new Date(n);
		return `${e.getUTCFullYear()}-${e.getUTCMonth() + 1}-${e.getUTCDate()}`;
	},
	l = (n) => {
		const e = new Date(n),
			t = (a) => String(a).padStart(2, "0"),
			r = -e.getTimezoneOffset(),
			s = r >= 0 ? "+" : "-",
			o = Math.abs(r);
		return `${t(e.getHours())}:${t(e.getMinutes())} UTC${s}${t(Math.floor(o / 60))}:${t(o % 60)}`;
	},
	m = (n, e = !1) => {
		const t = new Date(n),
			r = (o) => String(o).padStart(2, "0"),
			s = `${r(t.getUTCHours())}:${r(t.getUTCMinutes())}:${r(t.getUTCSeconds())} UTC`;
		return e
			? `${t.getUTCDate()} ${u[t.getUTCMonth()] ?? ""} ${t.getUTCFullYear()} · ${s}`
			: s;
	},
	L = (n, e) => {
		const t =
				new Date(n).toDateString() === new Date(e).toDateString()
					? `${f(n)} → ${l(e)}`
					: `${f(n)} → ${f(e)}`,
			r = (s) => m(s, A(s) !== M(s));
		return [t, `${r(n)} → ${r(e)}`];
	},
	D = (e) => {
		if (!e) return "";
		const t = new Date(e);
		if (Number.isNaN(t.getTime())) return String(e);
		const r = (g) => (g < 10 ? "0" : "") + g,
			s = -t.getTimezoneOffset(),
			o = Math.abs(s),
			a = s >= 0 ? "+" : "-";
		return `${t.toISOString().replace(/\.\d{3}Z$/, "Z")} (${t.getFullYear()}-${r(t.getMonth() + 1)}-${r(t.getDate())}T${r(t.getHours())}:${r(t.getMinutes())}:${r(t.getSeconds())}${a}${r((o / 60) | 0)}:${r(o % 60)})`;
	};

export { A, D, f, I, k, L, M, v };

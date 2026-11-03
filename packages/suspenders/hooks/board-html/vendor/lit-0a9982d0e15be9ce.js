// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
class h extends Event {
	constructor(e) {
		super(e, { bubbles: !0, composed: !0 });
	}
}
class p extends h {
	static eventName = "feed-refresh-requested";
	feed;
	constructor(e) {
		super(p.eventName);
		this.feed = e;
	}
}
class _ extends h {
	static eventName = "error-dismiss-requested";
	source;
	constructor(e) {
		super(_.eventName);
		this.source = e;
	}
}
function y(e) {
	if (e == null || e < 0) return "";
	if (e < 10) return "just now";
	if (e < 60) return `${e}s ago`;
	if (e < 3600) {
		const r = Math.round(e / 60);
		return `${r}${r === 1 ? " minute" : " minutes"} ago`;
	}
	if (e < 86400) {
		const r = Math.round(e / 3600);
		return `${r}${r === 1 ? " hour" : " hours"} ago`;
	}
	const t = Math.round(e / 86400);
	return `${t}${t === 1 ? " day" : " days"} ago`;
}
function P(e) {
	if (e == null || e < 0) return "-";
	if (e < 60) return `${e}s`;
	if (e < 3600) return `${Math.round(e / 60)}m`;
	if (e < 86400) return `${Math.round(e / 3600)}h`;
	return `${Math.round(e / 86400)}d`;
}
function se(e) {
	const t = Object.values(e).filter((n) => typeof n === "number");
	return Object.entries(e)
		.filter(([n, _l]) => t.indexOf(+n) === -1)
		.map(([_n, l]) => l);
}
function xe(_e, t) {
	if (typeof t === "bigint") return t.toString();
	return t;
}
class $e {
	constructor(e) {
		(this._getter = e), (this._value = void 0);
	}
	get value() {
		const e = this._getter;
		if (e !== void 0) (this._value = e()), (this._getter = void 0);
		return this._value;
	}
}
function ze(e) {
	return new $e(e);
}
function ce(e) {
	const t = e.startsWith("^") ? 1 : 0,
		r = e.endsWith("$") ? e.length - 1 : e.length;
	return e.slice(t, r);
}
function be(e, t, r) {
	Object.defineProperty(e, t, {
		value: r,
		writable: !0,
		enumerable: !0,
		configurable: !0,
	});
}
var ue = "captureStackTrace" in Error ? Error.captureStackTrace : (..._e) => {};
function Q(e) {
	return typeof e === "object" && e !== null && !Array.isArray(e);
}
function ve(e) {
	if (Q(e) === !1) return !1;
	const t = e.constructor;
	if (t === void 0) return !0;
	if (typeof t !== "function") return !0;
	const r = t.prototype;
	if (Q(r) === !1) return !1;
	if (Object.hasOwn(r, "isPrototypeOf") === !1) return !1;
	return !0;
}
var ye = new Set(["string", "number", "symbol"]);
function ee(e) {
	return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function te(e, t, r) {
	const n = new e._zod.constr(t ?? e._zod.def);
	if (!t || r?.parent) n._zod.parent = e;
	return n;
}
function D(e) {
	const t = e;
	if (!t) return {};
	if (typeof t === "string") return { error: () => t };
	if (t?.message !== void 0) {
		if (t?.error !== void 0)
			throw Error("Cannot specify both `message` and `error` params");
		t.error = t.message;
	}
	if ((delete t.message, typeof t.error === "string"))
		return { ...t, error: () => t.error };
	return t;
}
function Ze(e) {
	return Object.keys(e).filter(
		(t) => e[t]._zod.optin !== void 0 && e[t]._zod.optout === "optional",
	);
}
function U(e, t = 0) {
	if (e.aborted === !0) return !0;
	for (let r = t; r < e.issues.length; r++)
		if (e.issues[r]?.continue !== !0) return !0;
	return !1;
}
function we(e, t = 0) {
	if (e.aborted === !0) return !0;
	for (let r = t; r < e.issues.length; r++)
		if (e.issues[r]?.continue === !1) return !0;
	return !1;
}
function G(e, t) {
	return t.map((r) => {
		var n;
		return (n = r).path ?? (n.path = []), r.path.unshift(e), r;
	});
}
function Y(e) {
	return typeof e === "string" ? e : e?.message;
}
function ae(e) {
	const t = [];
	for (const r of e ?? []) {
		const n = r._zod.def;
		if (!/_(length|size)$|_equals$/.test(n.check)) break;
		const l = n.maximum ?? n.length ?? n.size;
		if (l >= 0) t.push([l, r]);
	}
	return t;
}
function re(e, t, r) {
	var n;
	for (let l = t; l < e.length; l++) (n = e[l]).schema ?? (n.schema = r);
}
function B(e, t, r) {
	var n;
	const l = e.inst?._zod?.traits;
	if (l?.has("$ZodType"))
		if (l.has("$ZodCheck")) (n = e).schema ?? (n.schema = e.inst);
		else e.schema = e.inst;
	const f = e.schema !== e.inst ? e.schema?._zod.def?.error : void 0,
		Z = e.message
			? e.message
			: (Y(e.inst?._zod.def?.error?.(e)) ??
				Y(f?.(e)) ??
				Y(t?.error?.(e)) ??
				Y(r.customError?.(e)) ??
				Y(r.localeError?.(e)) ??
				"Invalid input"),
		d = {};
	for (const v of Object.keys(e)) {
		if (
			v === "inst" ||
			v === "schema" ||
			v === "continue" ||
			v === "input" ||
			v === "__proto__"
		)
			continue;
		d[v] = e[v];
	}
	if ((d.path ?? (d.path = []), (d.message = Z), t?.reportInput))
		d.input = e.input;
	return d;
}
function Pe(e, t) {
	for (const r in t) {
		const n = Object.getOwnPropertyDescriptor(t, r);
		if (n.get) Object.defineProperty(e, r, { ...n, enumerable: !1 });
		else st(e, r, n.value);
	}
}
function X(e, t, r, n = !0) {
	return (
		Object.defineProperty(e, t, {
			configurable: !0,
			writable: !0,
			enumerable: n,
			value: r,
		}),
		r
	);
}
function ke(e, t, r) {
	return X(e, t, r, !1);
}
function st(e, t, r) {
	Object.defineProperty(e, t, {
		configurable: !0,
		get() {
			return this == null ? r : X(this, t, r.bind(this));
		},
		set(n) {
			X(this, t, n);
		},
	});
}
function ct(e, t) {
	const r = Object.getPrototypeOf(e);
	return t in r ? void 0 : r;
}
var ie,
	F = !1,
	ut = {
		configurable: !0,
		get() {
			F = !0;
			return;
		},
	};
function j(e, t, r) {
	const n = Object.getPrototypeOf(e._zod);
	if (t in n && ie !== e._zod) {
		ie = void 0;
		return;
	}
	(ie = e._zod),
		Object.defineProperty(n, t, {
			configurable: !0,
			get() {
				Object.defineProperty(this, t, ut);
				const l = F;
				F = !1;
				try {
					const f = r(this);
					if (F) delete this[t];
					else
						Object.defineProperty(this, t, {
							configurable: !0,
							writable: !0,
							value: f,
						});
					return (F = F || l), f;
				} catch (f) {
					throw (delete this[t], (F = F || l), f);
				}
			},
			set(l) {
				Object.defineProperty(this, t, {
					configurable: !0,
					writable: !0,
					value: l,
				});
			},
		});
}
function Ae(e, t, r, n) {
	const l = ct(e, t);
	if (!l) return;
	Object.defineProperty(l, t, {
		configurable: !0,
		get() {
			const f = {
				configurable: !0,
				writable: !0,
				enumerable: n,
				value: void 0,
			};
			return (
				Object.defineProperty(this, t, f),
				(f.value = r(this)),
				Object.defineProperty(this, t, f),
				f.value
			);
		},
		set(f) {
			Object.defineProperty(this, t, {
				configurable: !0,
				writable: !0,
				enumerable: n,
				value: f,
			});
		},
	});
}
var Ee;
var le = { value: void 0, enumerable: !1 },
	Me = "captureStackTrace" in Error ? Error : null;
function at(e) {
	const t = Me;
	if (t) {
		const r = t.stackTraceLimit;
		if (typeof r === "number") {
			try {
				t.stackTraceLimit = 0;
			} catch {
				return (Me = null), new e();
			}
			try {
				return new e();
			} finally {
				t.stackTraceLimit = r;
			}
		}
	}
	return new e();
}
function I(e, t, r, n) {
	const l = {};
	function f(w) {
		(this.def = w), (this.constr = k), (this.traits = new Set());
	}
	f.prototype = l;
	const Z = r,
		d = Z && new WeakSet();
	function v(w, M) {
		if (!w._zod) {
			le.value = new f(M);
			try {
				Object.defineProperty(w, "_zod", le);
			} finally {
				le.value = void 0;
			}
		} else if (w._zod.traits.has(e)) return;
		if ((w._zod.traits.add(e), t(w, M), d)) {
			let O = Object.getPrototypeOf(w),
				R = w._zod.constr.prototype,
				L = O;
			while (L && L !== R) L = Object.getPrototypeOf(L);
			const W = L ?? O;
			if (!d.has(W)) d.add(W), Pe(W, Z);
		}
		const A = k.prototype;
		for (const O in A) {
			if (!Object.hasOwn(A, O)) continue;
			if (!(O in w)) w[O] = A[O].bind(w);
		}
	}
	const b = n?.Parent ?? Object;
	class x extends b {}
	Object.defineProperty(x, "name", { value: e });
	function k(w) {
		const M = n?.Parent ? at(x) : this;
		v(M, w);
		const A = M._zod.deferred;
		if (A) {
			for (const R of A) R();
			M._zod.deferred = void 0;
		}
		const O = globalThis.__zod_globalConfig?.postProcessor;
		if (O) O(M);
		return M;
	}
	return (
		Object.defineProperty(k, "init", { value: v }),
		Object.defineProperty(k, Symbol.hasInstance, {
			value: (w) => {
				if (n?.Parent && w instanceof n.Parent) return !0;
				return w?._zod?.traits?.has(e);
			},
		}),
		Object.defineProperty(k, "name", { value: e }),
		k
	);
}
class K extends Error {
	constructor() {
		super(
			"Encountered Promise during synchronous parse. Use .parseAsync() instead.",
		);
	}
}
(Ee = globalThis).__zod_globalConfig ?? (Ee.__zod_globalConfig = {});
var J = globalThis.__zod_globalConfig;
function V(e) {
	if (e) Object.assign(J, e);
	return J;
}
function lt() {
	const e = this._zod;
	return e.message ?? (e.message = JSON.stringify(e.def, xe, 2)), e.message;
}
function pt(e) {
	this._zod.message = e;
}
var ft = { get: lt, set: pt, enumerable: !0, configurable: !0 },
	pe = { value: void 0, enumerable: !1 },
	Ie = new WeakSet([Object.prototype, Error.prototype]),
	Oe = (e, t) => {
		(e.name = "$ZodError"),
			(pe.value = t),
			Object.defineProperty(e, "issues", pe),
			(pe.value = void 0),
			Object.defineProperty(e, "message", ft);
		const r = Object.getPrototypeOf(e);
		if (!Ie.has(r))
			Ie.add(r),
				Object.defineProperty(r, "toString", {
					configurable: !0,
					enumerable: !1,
					get() {
						const n = () => this.message;
						return (
							Object.defineProperty(this, "toString", {
								value: n,
								configurable: !0,
								writable: !0,
							}),
							n
						);
					},
					set(n) {
						Object.defineProperty(this, "toString", {
							value: n,
							configurable: !0,
							writable: !0,
						});
					},
				});
	},
	_Bt = I("$ZodError", Oe),
	q = I("$ZodError", Oe, void 0, { Parent: Error });
function dt(e) {
	const t = [],
		r = e.map((n) => (typeof n === "object" ? n.key : n));
	for (const n of r)
		if (typeof n === "number") t.push(`[${n}]`);
		else if (typeof n === "symbol") t.push(`[${JSON.stringify(String(n))}]`);
		else if (/[^\w$]/.test(n)) t.push(`[${JSON.stringify(n)}]`);
		else {
			if (t.length) t.push(".");
			t.push(n);
		}
	return t.join("");
}
function E(e) {
	const t = [],
		r = [...e.issues].sort(
			(n, l) => (n.path ?? []).length - (l.path ?? []).length,
		);
	for (const n of r)
		if ((t.push(`✖ ${n.message}`), n.path?.length))
			t.push(`  → at ${dt(n.path)}`);
	return t.join(`
`);
}
var ht = (e) => {
		const t = (r, n, l, f) => {
			const Z = l ? { ...l, async: !1 } : { async: !1 },
				d = r._zod.run({ value: n, issues: [] }, Z);
			if (d instanceof Promise) throw new K();
			if (d.issues.length) {
				const v = new (f?.Err ?? e)(d.issues.map((b) => B(b, Z, V())));
				throw (ue(v, f?.callee ?? t), v);
			}
			return d.value;
		};
		return t;
	},
	fe = ht(q),
	_t = (e) => {
		const t = async (r, n, l, f) => {
			let Z = l ? { ...l, async: !0 } : { async: !0 },
				d = r._zod.run({ value: n, issues: [] }, Z);
			if (d instanceof Promise) d = await d;
			if (d.issues.length) {
				const v = new (f?.Err ?? e)(d.issues.map((b) => B(b, Z, V())));
				throw (ue(v, f?.callee ?? t), v);
			}
			return d.value;
		};
		return t;
	},
	de = _t(q),
	gt = (e) => (t, r, n) => {
		const l = n ? { ...n, async: !1 } : { async: !1 },
			f = t._zod.run({ value: r, issues: [] }, l);
		if (f instanceof Promise) throw new K();
		return f.issues.length
			? Ce(e, f.issues, l)
			: { success: !0, data: f.value };
	},
	me = gt(q);
function Ce(e, t, r) {
	let n;
	return {
		success: !1,
		get error() {
			if (!n)
				(n = new e(t.map((l) => B(l, r, V())))), (t = void 0), (r = void 0);
			return n;
		},
		set error(l) {
			(n = l), (t = void 0), (r = void 0);
		},
	};
}
var xt = (e) => async (t, r, n) => {
		let l = n ? { ...n, async: !0 } : { async: !0 },
			f = t._zod.run({ value: r, issues: [] }, l);
		if (f instanceof Promise) f = await f;
		return f.issues.length
			? Ce(e, f.issues, l)
			: { success: !0, data: f.value };
	},
	he = xt(q);
var Re = /^[\s\S]{0,}$/;
var _e = /^-?\d+(?:\.\d+)?$/,
	Te = /^(?:true|false)$/i;
var je = { major: 4, minor: 6, patch: 7 };
var C = I(
		"$ZodType",
		(e, t) => {
			var r;
			e ?? (e = {}),
				(e._zod.def = t),
				(e._zod.bag = e._zod.bag || {}),
				(e._zod.version = je);
			const n = e._zod.def.checks,
				l = e._zod.traits.has("$ZodCheck")
					? [e, ...(n ?? [])]
					: n?.length
						? [...n]
						: [];
			for (const f of l) for (const Z of f._zod.onattach) Z(e);
			if (l.length === 0)
				(r = e._zod).deferred ?? (r.deferred = []),
					e._zod.deferred?.push(() => {
						e._zod.run = e._zod.parse;
					});
			else {
				const f = (d, v, b) => {
						if (d.memo) return d;
						let x = U(d),
							k;
						for (const w of v) {
							if (w._zod.def.when) {
								if (we(d)) continue;
								if (!w._zod.def.when(d)) continue;
							} else if (x) continue;
							const M = d.issues.length,
								A = w._zod.check(d);
							if (A instanceof Promise && b?.async === !1) throw new K();
							if (k || A instanceof Promise)
								k = (k ?? Promise.resolve()).then(async () => {
									if ((await A, d.issues.length === M)) return;
									if ((re(d.issues, M, e), !x)) x = U(d, M);
								});
							else {
								if (d.issues.length === M) continue;
								if ((re(d.issues, M, e), !x)) x = U(d, M);
							}
						}
						if (k) return k.then(() => d);
						return d;
					},
					Z = (d, v, b) => {
						if (U(d)) return (d.aborted = !0), d;
						const x = f(v, l, b);
						if (x instanceof Promise) {
							if (b.async === !1) throw new K();
							return x.then((k) => e._zod.parse(k, b));
						}
						return e._zod.parse(x, b);
					};
				e._zod.run = (d, v) => {
					if (v.skipChecks) return e._zod.parse(d, v);
					if (v.direction === "backward") {
						const x = e._zod.parse(
							{ value: d.value, issues: [] },
							{ ...v, skipChecks: !0 },
						);
						if (x instanceof Promise) return x.then((k) => Z(k, d, v));
						return Z(x, d, v);
					}
					const b = e._zod.parse(d, v);
					if (b instanceof Promise) {
						if (v.async === !1) throw new K();
						return b.then((x) => f(x, l, v));
					}
					return f(b, l, v);
				};
			}
		},
		{
			get "~standard"() {
				return ke(this, "~standard", bt(this));
			},
			set "~standard"(e) {
				X(this, "~standard", e);
			},
		},
	),
	Fe = (e, t) =>
		e.issues.length
			? { issues: e.issues.map((r) => B(r, t, V())) }
			: { value: e.value };
async function zt(e, t) {
	const r = { async: !0 };
	return Fe(await e._zod.run({ value: t, issues: [] }, r), r);
}
function bt(e) {
	return {
		validate: (t) => {
			const r = { async: !1 };
			try {
				const n = e._zod.run({ value: t, issues: [] }, r);
				if (!(n instanceof Promise)) return Fe(n, r);
			} catch (_n) {}
			return zt(e, t);
		},
		vendor: "zod",
		version: 1,
	};
}
var Ue = I("$ZodString", (e, t) => {
	C.init(e, t),
		(e._zod.pattern = t.pattern ?? Re),
		(e._zod.parse = (r, _n) => {
			if (t.coerce)
				try {
					r.value = String(r.value);
				} catch (_l) {}
			if (typeof r.value === "string") return r;
			return (
				r.issues.push({
					expected: "string",
					code: "invalid_type",
					input: r.value,
					inst: e,
				}),
				r
			);
		});
});
var Be = I("$ZodNumber", (e, t) => {
	C.init(e, t),
		(e._zod.pattern = _e),
		(e._zod.parse = (r, _n) => {
			if (t.coerce)
				try {
					r.value = Number(r.value);
				} catch (_Z) {}
			const l = r.value;
			if (typeof l === "number" && !Number.isNaN(l) && Number.isFinite(l))
				return r;
			const f =
				typeof l === "number"
					? Number.isNaN(l)
						? "NaN"
						: !Number.isFinite(l)
							? String(l)
							: void 0
					: void 0;
			return (
				r.issues.push({
					expected: "number",
					code: "invalid_type",
					input: l,
					inst: e,
					...(f ? { received: f } : {}),
				}),
				r
			);
		});
});
var Ke = I("$ZodBoolean", (e, t) => {
	C.init(e, t),
		(e._zod.pattern = Te),
		(e._zod.parse = (r, _n) => {
			if (t.coerce)
				try {
					r.value = Boolean(r.value);
				} catch (_f) {}
			const l = r.value;
			if (typeof l === "boolean") return r;
			return (
				r.issues.push({
					expected: "boolean",
					code: "invalid_type",
					input: l,
					inst: e,
				}),
				r
			);
		});
});
var Ve = I("$ZodUnknown", (e, t) => {
	C.init(e, t), (e._zod.parse = (r) => r);
});
function vt(e, t) {
	const r = ae(e._zod.def.checks);
	if (!r.length) return;
	const n = Math.min(...r.map((f) => f[0])),
		l = e._zod.parse;
	e._zod.parse = (f, Z) => {
		const d = t(f.value);
		if (d > n && !Z?.skipChecks && Z?.direction !== "backward") {
			for (const [v, b] of ae(e._zod.def.checks))
				if (d > v && b._zod.def.when(f)) {
					const x = f.issues.length;
					return (
						b._zod.check(f), (f.issues[x].continue = !1), re(f.issues, x, e), f
					);
				}
		}
		return l(f, Z);
	};
}
var yt = (e) => (Array.isArray(e) ? e.length : -1);
function Ne(e, t, r) {
	if (e.issues.length) t.issues.push(...G(r, e.issues));
	t.value[r] = e.value;
}
var Xe = I("$ZodArray", (e, t) => {
	C.init(e, t);
	const r = J.memoizer;
	r?.attach(e),
		(e._zod.parse = (n, l) => {
			const f = n.value;
			if (!Array.isArray(f))
				return (
					n.issues.push({
						expected: "array",
						code: "invalid_type",
						input: f,
						inst: e,
					}),
					n
				);
			n.value = r ? r.alloc(e, n, Array(f.length), l) : Array(f.length);
			const Z = [],
				d = l?.abortEarly;
			for (let v = 0; v < f.length; v++) {
				const b = f[v],
					x = t.element._zod.run({ value: b, issues: [] }, l);
				if (x instanceof Promise) Z.push(x.then((k) => Ne(k, n, v)));
				else if ((Ne(x, n, v), d && x.issues.length !== 0 && U(x))) break;
			}
			if (Z.length) return Promise.all(Z).then(() => n);
			return n;
		}),
		vt(e, yt);
});
function ne(e, t, r, n, l, f) {
	const Z = r in n,
		d = f === "optional";
	if (!Z && d && l === "optional") return;
	if (e.issues.length) {
		if (l !== void 0 && d && !Z) return;
		t.issues.push(...G(r, e.issues));
	}
	if (!Z && l === void 0) {
		if (!e.issues.length)
			t.issues.push({
				code: "invalid_type",
				expected: "nonoptional",
				input: void 0,
				path: [r],
			});
		return;
	}
	if (e.value === void 0) {
		if (Z || (l === "defaulted" && !d)) t.value[r] = void 0;
	} else t.value[r] = e.value;
}
var Zt = [];
function wt(e) {
	const t = Object.keys(e.shape),
		r = Object.getOwnPropertySymbols(e.shape),
		n = r.length ? r : Zt,
		l = n.length ? [...t, ...n] : t;
	for (const Z of l)
		if (!e.shape?.[Z]?._zod?.traits?.has("$ZodType"))
			throw Error(
				`Invalid element at key "${String(Z)}": expected a Zod schema`,
			);
	const f = Ze(e.shape);
	return {
		...e,
		allKeys: l,
		symbolKeys: n,
		keySet: new Set(t),
		numKeys: t.length,
		optionalKeys: new Set(f),
	};
}
function Pt(e, t, r, n, l, f, Z) {
	let d = [],
		v = l.keySet,
		b = l.catchall._zod,
		x = b.def.type,
		{ optin: k, optout: w } = b,
		M = 0;
	for (const A in t) {
		if (Z && r.issues.length !== M) {
			if (U(r, M)) break;
			M = r.issues.length;
		}
		if (v.has(A)) continue;
		if (A === "__proto__") {
			if (x === "never") d.push(A);
			continue;
		}
		if (x === "never") {
			d.push(A);
			continue;
		}
		const O = b.run({ value: t[A], issues: [] }, n);
		if (O instanceof Promise) e.push(O.then((R) => ne(R, r, A, t, k, w)));
		else ne(O, r, A, t, k, w);
	}
	if (d.length)
		r.issues.push({
			code: "unrecognized_keys",
			keys: d,
			input: t,
			inst: f,
			continue: !0,
		});
	if (!e.length) return r;
	return Promise.all(e).then(() => r);
}
var Ge = I("$ZodObject", (e, t) => {
	C.init(e, t);
	const r = Object.getOwnPropertyDescriptor(t, "shape"),
		n = r?.get ? r.get.raw : (t.shape ?? {});
	if (n) {
		const b = () => {
			const x = { ...n };
			return Object.defineProperty(t, "shape", { value: x }), (b.raw = x), x;
		};
		(b.raw = n), Object.defineProperty(t, "shape", { get: b });
	}
	const l = ze(() => wt(t));
	j(e, "propValues", (b) => {
		const x = b.def.shape,
			k = {};
		for (const w in x) {
			const M = x[w]._zod;
			if (M.values) {
				if (!Object.hasOwn(k, w)) be(k, w, new Set());
				for (const A of M.values) k[w].add(A);
				if (M.optin !== void 0) k[w].add(void 0);
			}
		}
		return k;
	});
	let f = Q,
		Z = t.catchall,
		d,
		v = J.memoizer;
	v?.attach(e),
		(e._zod.parse = (b, x) => {
			d ?? (d = l.value);
			const k = b.value;
			if (!f(k))
				return (
					b.issues.push({
						expected: "object",
						code: "invalid_type",
						input: k,
						inst: e,
					}),
					b
				);
			b.value = v ? v.alloc(e, b, {}, x) : {};
			let w = [],
				M = d.shape,
				A = x?.abortEarly,
				O = b.issues.length;
			for (const R of d.allKeys) {
				if (A && b.issues.length !== O) {
					if (U(b, O)) break;
					O = b.issues.length;
				}
				if (R === "__proto__") continue;
				const L = M[R],
					W = L._zod.optin,
					ge = L._zod.optout,
					oe = L._zod.run({ value: k[R], issues: [] }, x);
				if (oe instanceof Promise)
					w.push(oe.then((it) => ne(it, b, R, k, W, ge)));
				else ne(oe, b, R, k, W, ge);
			}
			if (!Z) return w.length ? Promise.all(w).then(() => b) : b;
			return Pt(w, k, b, x, l.value, e, A === !0);
		});
});
var We = I("$ZodRecord", (e, t) => {
	C.init(e, t);
	const r = J.memoizer;
	r?.attach(e),
		(e._zod.parse = (n, l) => {
			const f = n.value;
			if (!ve(f))
				return (
					n.issues.push({
						expected: "record",
						code: "invalid_type",
						input: f,
						inst: e,
					}),
					n
				);
			const Z = [],
				d = t.keyType._zod.values;
			if (d && !t.partial) {
				n.value = r ? r.alloc(e, n, {}, l) : {};
				const v = new Set();
				for (const x of d)
					if (
						typeof x === "string" ||
						typeof x === "number" ||
						typeof x === "symbol"
					) {
						if (
							(v.add(typeof x === "number" ? x.toString() : x),
							x === "__proto__")
						)
							continue;
						const k = t.keyType._zod.run({ value: x, issues: [] }, l);
						if (k instanceof Promise)
							throw Error(
								"Async schemas not supported in object keys currently",
							);
						if (k.issues.length) {
							n.issues.push({
								code: "invalid_key",
								origin: "record",
								issues: k.issues.map((A) => B(A, l, V())),
								input: x,
								path: [x],
								inst: e,
							});
							continue;
						}
						const w = k.value;
						if (w === "__proto__") continue;
						const M = t.valueType._zod.run({ value: f[x], issues: [] }, l);
						if (M instanceof Promise)
							Z.push(
								M.then((A) => {
									if (A.issues.length) n.issues.push(...G(x, A.issues));
									n.value[w] = A.value;
								}),
							);
						else {
							if (M.issues.length) n.issues.push(...G(x, M.issues));
							n.value[w] = M.value;
						}
					}
				let b;
				for (const x in f)
					if (!v.has(x))
						if (t.mode === "loose") {
							if (x === "__proto__") continue;
							n.value[x] = f[x];
						} else (b = b ?? []), b.push(x);
				if (b && b.length > 0)
					n.issues.push({
						code: "unrecognized_keys",
						input: f,
						inst: e,
						keys: b,
						continue: !0,
					});
			} else {
				n.value = r ? r.alloc(e, n, {}, l) : {};
				let v;
				for (const b of Reflect.ownKeys(f)) {
					if (b === "__proto__") continue;
					if (!Object.prototype.propertyIsEnumerable.call(f, b)) continue;
					let x = t.keyType._zod.run({ value: b, issues: [] }, l);
					if (x instanceof Promise)
						throw Error("Async schemas not supported in object keys currently");
					if (typeof b === "string" && _e.test(b) && x.issues.length) {
						const A = t.keyType._zod.run({ value: Number(b), issues: [] }, l);
						if (A instanceof Promise)
							throw Error(
								"Async schemas not supported in object keys currently",
							);
						if (A.issues.length === 0) x = A;
					}
					if (x.issues.length) {
						if (t.mode === "loose") n.value[b] = f[b];
						else if (d) (v = v ?? []), v.push(b);
						else
							n.issues.push({
								code: "invalid_key",
								origin: "record",
								issues: x.issues.map((A) => B(A, l, V())),
								input: b,
								path: [b],
								inst: e,
							});
						continue;
					}
					const w = x.value;
					if (w === "__proto__") continue;
					const M = t.valueType._zod.run({ value: f[b], issues: [] }, l);
					if (M instanceof Promise)
						Z.push(
							M.then((A) => {
								if (A.issues.length) n.issues.push(...G(b, A.issues));
								n.value[w] = A.value;
							}),
						);
					else {
						if (M.issues.length) n.issues.push(...G(b, M.issues));
						n.value[w] = M.value;
					}
				}
				if (v && v.length > 0)
					n.issues.push({
						code: "unrecognized_keys",
						input: f,
						inst: e,
						keys: v,
						continue: !0,
					});
			}
			if (Z.length) return Promise.all(Z).then(() => n);
			return n;
		});
});
var He = I("$ZodEnum", (e, t) => {
		C.init(e, t);
		const r = se(t.entries),
			n = new Set(r);
		(e._zod.values = n),
			j(e, "pattern", (l) => {
				const f = se(l.def.entries).filter((Z) => ye.has(typeof Z));
				return new RegExp(
					f.length
						? `^(${f.map((Z) => ee(Z.toString())).join("|")})$`
						: "^[^\\s\\S]$",
				);
			}),
			(e._zod.parse = (l, _f) => {
				const Z = l.value;
				if (n.has(Z)) return l;
				return (
					l.issues.push({
						code: "invalid_value",
						values: r,
						input: Z,
						inst: e,
					}),
					l
				);
			});
	}),
	Je = I("$ZodLiteral", (e, t) => {
		C.init(e, t);
		const r = new Set(t.values);
		(e._zod.values = r),
			j(e, "pattern", (n) => {
				const l = n.def.values;
				return new RegExp(
					l.length
						? `^(${l.map((f) => (typeof f === "string" ? ee(f) : f ? ee(f.toString()) : String(f))).join("|")})$`
						: "^[^\\s\\S]$",
				);
			}),
			(e._zod.parse = (n, _l) => {
				const f = n.value;
				if (r.has(f)) return n;
				return (
					n.issues.push({
						code: "invalid_value",
						values: t.values,
						input: f,
						inst: e,
					}),
					n
				);
			});
	});
function Le(e, t) {
	return (e.value = t.issues.length ? void 0 : t.value), e;
}
var Ye = I("$ZodOptional", (e, t) => {
	C.init(e, t),
		j(e, "optin", (r) =>
			r.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional",
		),
		(e._zod.optout = "optional"),
		j(e, "values", (r) => {
			const n = r.def.innerType._zod.values;
			return n ? new Set([...n, void 0]) : void 0;
		}),
		j(e, "pattern", (r) => {
			const n = r.def.innerType._zod.pattern;
			return n ? new RegExp(`^(${ce(n.source)})?$`) : void 0;
		}),
		(e._zod.parse = (r, n) => {
			if (r.value === void 0) {
				if (t.innerType._zod.optin !== "defaulted") return r;
				const l = t.innerType._zod.run({ value: r.value, issues: [] }, n);
				if (l instanceof Promise) return l.then((f) => Le(r, f));
				return Le(r, l);
			}
			return t.innerType._zod.run(r, n);
		});
});
var qe = I("$ZodNullable", (e, t) => {
	C.init(e, t),
		j(e, "optin", (r) => r.def.innerType._zod.optin),
		j(e, "optout", (r) => r.def.innerType._zod.optout),
		j(e, "pattern", (r) => {
			const n = r.def.innerType._zod.pattern;
			return n ? new RegExp(`^(${ce(n.source)}|null)$`) : void 0;
		}),
		j(e, "values", (r) =>
			r.def.innerType._zod.values
				? new Set([...r.def.innerType._zod.values, null])
				: void 0,
		),
		(e._zod.parse = (r, n) => {
			if (r.value === null) return r;
			return t.innerType._zod.run(r, n);
		});
});
function Qe(e) {
	if (e.checks) e.checks = [...e.checks];
	return e;
}
function et(e, t) {
	return new e(Qe({ type: "string", ...D(t) }));
}
function tt(e, t) {
	return new e(Qe({ type: "number", checks: [], ...D(t) }));
}
function rt(e, t) {
	return new e({ type: "boolean", ...D(t) });
}
function nt(e) {
	return new e({ type: "unknown" });
}
var N = I(
		"ZodMiniType",
		(e, t) => {
			if (!e._zod) throw Error("Uninitialized schema in ZodMiniType.");
			C.init(e, t), (e.def = t), (e.type = t.type);
		},
		{
			get with() {
				return this.check;
			},
			set with(e) {
				X(this, "with", e);
			},
			parse(e, t) {
				return fe(this, e, t, { callee: this.parse });
			},
			parseAsync(e, t) {
				return de(this, e, t, { callee: this.parseAsync });
			},
			safeParse(e, t) {
				return me(this, e, t);
			},
			safeParseAsync(e, t) {
				return he(this, e, t);
			},
			check(...e) {
				const t = this.def;
				return this.clone(
					{
						...t,
						checks: [
							...(t.checks ?? []),
							...e.map((r) =>
								typeof r === "function"
									? {
											_zod: {
												check: r,
												def: { check: "custom" },
												onattach: [],
											},
										}
									: r,
							),
						],
					},
					{ parent: !0 },
				);
			},
			clone(e, t) {
				return te(this, e, t);
			},
			brand() {
				return this;
			},
			register(e, t) {
				return e.add(this, t), this;
			},
			apply(e, ...t) {
				return t.length === 0 ? e(this) : e(this, ...t);
			},
		},
	),
	Et = I("ZodMiniString", (e, t) => {
		Ue.init(e, t), N.init(e, t);
	});
function s(e) {
	return et(Et, e);
}
var Mt = I("ZodMiniNumber", (e, t) => {
	Be.init(e, t), N.init(e, t);
});
function c(e) {
	return tt(Mt, e);
}
var St = I("ZodMiniBoolean", (e, t) => {
	Ke.init(e, t), N.init(e, t);
});
function T(e) {
	return rt(St, e);
}
var It = I("ZodMiniUnknown", (e, t) => {
	Ve.init(e, t), N.init(e, t);
});
function m() {
	return nt(It);
}
var Ot = I("ZodMiniArray", (e, t) => {
	Xe.init(e, t), N.init(e, t);
});
function a(e, t) {
	return new Ot({ type: "array", element: e, ...D(t) });
}
var Ct = I("ZodMiniObject", (e, t) => {
	Ge.init(e, t), N.init(e, t), Ae(e, "shape", (r) => r._zod.def.shape, !1);
});
function i(e, t) {
	return new Ct({ type: "object", shape: e, catchall: m(), ...D(t) });
}
var ot = I("ZodMiniRecord", (e, t) => {
	We.init(e, t), N.init(e, t);
});
function g(e, t, r) {
	if (!t?._zod)
		return new ot({ type: "record", keyType: s(), valueType: e, ...D(t) });
	return new ot({ type: "record", keyType: e, valueType: t, ...D(r) });
}
var Rt = I("ZodMiniEnum", (e, t) => {
	He.init(e, t), N.init(e, t), (e.options = [...e._zod.values]);
});
function S(e, t) {
	const r = Array.isArray(e) ? Object.fromEntries(e.map((n) => [n, n])) : e;
	return new Rt({ type: "enum", entries: r, ...D(t) });
}
var Tt = I("ZodMiniLiteral", (e, t) => {
	Je.init(e, t), N.init(e, t);
});
function z(e, t) {
	return new Tt({
		type: "literal",
		values: Array.isArray(e) ? e : [e],
		...D(t),
	});
}
var Dt = I("ZodMiniOptional", (e, t) => {
	Ye.init(e, t), N.init(e, t);
});
function o(e) {
	return new Dt({ type: "optional", innerType: e });
}
var jt = I("ZodMiniNullable", (e, t) => {
	qe.init(e, t), N.init(e, t);
});
function u(e) {
	return new jt({ type: "nullable", innerType: e });
}

export { _, a, c, E, g, h, i, m, o, P, p, S, s, T, u, y, z };

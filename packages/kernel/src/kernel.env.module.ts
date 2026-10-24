// kernel.env.module.ts — env access with trim-and-empty semantics. The
// process.env.X ?? fallback idiom passes on "" and " " — the ~411-site bug
// class W1254 centralizes here. Proven instance: servicemon's parseRefreshS
// (trim → empty → fallback, Number + finite guard) — env.num matches it.
// Kernel imports nothing in fleet.
//
//	env.str("BUCKLE_URL", "http://127.0.0.1:4101")  // " " → fallback
//	env.num("STATUS_REFRESH_S", 5)                  // "0" → 0, "x" → 5
export const env = {
	/** Trimmed non-empty string or the fallback: unset / "" / whitespace /
	 * untrimmable values fall back; a survivor returns trimmed. */
	str(name: string, fallback: string): string {
		const raw = process.env[name];
		const t = (raw ?? "").trim();
		return t === "" ? fallback : t;
	},
	/** Finite number or the fallback: unset / non-numeric / empty fall back;
	 * "0" and negatives are values, not fallbacks (STATUS_REFRESH_S=0 means
	 * always-fresh — a "0 means default" client passes 0 explicitly). */
	num(name: string, fallback: number): number {
		const raw = (process.env[name] ?? "").trim();
		const n = Number(raw);
		return raw === "" || !Number.isFinite(n) ? fallback : n;
	},
};

// router-arith.ts — deterministic arithmetic lane (moved verbatim from
// router-shim.ts, W1238.6.1): a pure-math ask is evaluated directly, never
// sent to an LLM — Qwen3-4B answers 17*23 -> "401" at temp 0 (verified
// 2026-09-23). Strict allowlist; anything ambiguous fails safe to the LLM.
// arithmetic lane: a pure-math ask is evaluated directly, never sent to an
// LLM — Qwen3-4B deterministically answers 17*23 -> "401" at temp 0 (verified
// 2026-09-23). Strict allowlist; anything ambiguous fails safe to the LLM.
const ARITH_LEAD =
	/^(what\s+is|what's|whats|calculate|compute|how\s+much\s+is|how\s+many\s+is|hvad\s+er|hvor\s+meget\s+er)\s+/i;
const ARITH_TAIL =
	/\s*[,.;]?\s*(answer|reply|respond|svar)(\s+\w+){0,3}\s*(the\s+)?(number|result|tallet)(\s+only)?[.]*$/i;
export function arithmeticAnswer(text: string): string | null {
	let t = text
		.trim()
		.replace(ARITH_LEAD, "")
		.replace(ARITH_TAIL, "")
		.replace(/[?!.]+$/, "")
		.trim();
	if (!t || t.length > 120) return null;
	t = t.replace(/\bx\b|×/gi, "*").replace(/÷/g, "/");
	if (!/^[\d\s+\-*/()]+$/.test(t)) return null; // strict charset
	if (!/\d/.test(t) || (!/[+*/]/.test(t) && !/\d\s*-\s*\d/.test(t)))
		return null; // need an operator
	const tokens = t.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
	if (!tokens) return null;
	const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
	const out: (number | string)[] = [];
	const ops: string[] = [];
	let prev: "n" | "op" | "(" | ")" | null = null;
	for (const tk of tokens) {
		if (/^\d/.test(tk)) {
			out.push(parseFloat(tk));
			prev = "n";
			continue;
		}
		if (tk === "(") {
			ops.push(tk);
			prev = "(";
			continue;
		}
		if (tk === ")") {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(") break;
				ops.pop();
				out.push(top);
			}
			if (!ops.includes("(")) return null;
			ops.pop();
			prev = ")";
			continue;
		}
		if (tk === "-" && (prev === null || prev === "op" || prev === "("))
			out.push(0); // unary minus
		else {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(" || (prec[top] ?? 0) < prec[tk])
					break;
				ops.pop();
				out.push(top);
			}
		}
		ops.push(tk);
		prev = "op";
	}
	while (ops.length) {
		const o = ops.pop();
		if (o === undefined || o === "(") return null;
		out.push(o);
	}
	const st: number[] = [];
	for (const tk of out) {
		if (typeof tk === "number") {
			st.push(tk);
			continue;
		}
		const b = st.pop();
		const a = st.pop();
		if (a === undefined || b === undefined) return null;
		st.push(
			tk === "+" ? a + b : tk === "-" ? a - b : tk === "*" ? a * b : a / b,
		);
	}
	if (st.length !== 1 || !Number.isFinite(st[0])) return null;
	const r = st[0];
	return String(
		Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : Number(r.toFixed(6)),
	);
}

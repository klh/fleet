// mechanical secrets pass (layer 2 of 2 — the LLM's no-secrets prompt rule is
// layer 1): credential-shaped patterns (gitleaks-inspired, original code). A
// private-key block is unrecoverable context → the candidate is rejected.
const SECRET_PATTERNS: { re: RegExp; kind: string }[] = [
	{ re: /\bbksk_[A-Za-z0-9_-]{24,}\b/g, kind: "buckle callback key" },
	{
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		kind: "private key block",
	},
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, kind: "aws access key" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, kind: "github token" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, kind: "slack token" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, kind: "google api key" },
	{ re: /\bsk_(live|test)_[0-9A-Za-z]{16,}\b/g, kind: "stripe key" },
	{ re: /\bnpm_[A-Za-z0-9]{36}\b/g, kind: "npm token" },
	{ re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, kind: "bearer token" },
	{
		re: /\b(api[_-]?key|secret|token|password|passwd|pwd|authorization)\b\s*[:=]\s*\S+/gi,
		kind: "credential assignment",
	},
];

// redact in place; a private-key block rejects the whole candidate
export function redactSecrets(text: string): {
	text: string;
	rejected: boolean;
	hits: string[];
} {
	let rejected = false;
	const hits: string[] = [];
	let out = text;
	for (const p of SECRET_PATTERNS) {
		p.re.lastIndex = 0;
		if (!p.re.test(out)) continue;
		p.re.lastIndex = 0;
		out = out.replace(p.re, () => {
			hits.push(p.kind);
			return p.kind === "private key block" ? "[REJECTED-KEY]" : "[REDACTED]";
		});
		if (p.kind === "private key block") rejected = true;
	}
	return { text: out, rejected, hits };
}

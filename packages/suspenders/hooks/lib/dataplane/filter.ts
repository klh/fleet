// hooks/lib/dataplane/filter.ts — W2326: AIP-160 subset parser for the
// dataplane List methods (W2319 docs/design/dataplane-api.md). Accepts
// `=`, `!=`, `<`, `>`, `<=`, `>=`, `:` (contains), AND/OR/NOT keywords
// (uppercase, per AIP-160), parentheses, and dot-paths into a row's own
// JSON columns. Emits a parameterized SQL WHERE fragment — every value is
// a bound parameter, never interpolated. Unknown field = FilterError
// naming it (the service maps that to problem+json invalid_argument).
// Deliberately NOT in v0: functions, `*` wildcards, IN arrays, order_by
// (ordering is the service's concern, not the filter's).
import type { FieldMap, FieldSpec, SqlFragment, SqlParam } from "./types.ts";

export type { FieldMap, FieldSpec, SqlFragment, SqlParam };

export class FilterError extends Error {
	readonly field?: string;

	constructor(message: string, field?: string) {
		super(message);
		this.name = "FilterError";
		this.field = field;
	}
}

/** Parse an AIP-160 subset filter into a parameterized WHERE fragment. */
export function parseFilter(filter: string, fields: FieldMap): SqlFragment {
	const tokens = tokenize(filter);
	if (tokens.length === 0) return { sql: "", params: [] };
	const parser = new Parser(tokens, fields);
	const expr = parser.parseExpr();
	parser.expectEnd();
	const emitter = new Emitter(fields);
	return emitter.emit(expr);
}

// ---- AST ----

type BinaryOp = "AND" | "OR";
type CompareOp = "=" | "!=" | "<" | ">" | "<=" | ">=" | ":";

/** value = bare word | quoted string | number (sign and digits kept raw). */
interface Comparison {
	field: string;
	path: string[]; // dot-path segments AFTER the field root; [] = the column itself
	op: CompareOp;
	value: string;
}

interface NotExpr {
	kind: "not";
	inner: Expr;
}
interface AndOrExpr {
	kind: "andor";
	op: BinaryOp;
	left: Expr;
	right: Expr;
}
interface CmpExpr {
	kind: "cmp";
	cmp: Comparison;
}
type Expr = NotExpr | AndOrExpr | CmpExpr;

// ---- lexer ----

type Token =
	| { t: "lp" }
	| { t: "rp" }
	| { t: "and" }
	| { t: "or" }
	| { t: "not" }
	| { t: "op"; op: CompareOp }
	| { t: "value"; v: string };

/** Bare-word characters: letters, digits, underscore, asterisk. */
function isWordChar(c: string): boolean {
	return /[A-Za-z0-9_*]/.test(c);
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const c = input[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === "(") {
			tokens.push({ t: "lp" });
			i++;
			continue;
		}
		if (c === ")") {
			tokens.push({ t: "rp" });
			i++;
			continue;
		}
		const tok = lexString(input, i) ?? lexOperator(input, i) ?? lexWord(input, i);
		if (!tok)
			throw new FilterError(`unexpected character ${JSON.stringify(c)} in filter`);
		tokens.push(tok.token);
		i = tok.next;
	}
	return tokens;
}

/** Quoted string at `i` (delimited by \" or '), backslash escapes. */
function lexString(
	input: string,
	i: number,
): { token: Token; next: number } | undefined {
	const quote = input[i];
	if (quote !== '"' && quote !== "'") return undefined;
	let j = i + 1;
	let s = "";
	while (j < input.length) {
		const ch = input[j];
		if (ch === "\\" && j + 1 < input.length) {
			s += input[j + 1];
			j += 2;
			continue;
		}
		if (ch === quote) return { token: { t: "value", v: s }, next: j + 1 };
		if (ch === "\n") break;
		s += ch;
		j++;
	}
	throw new FilterError("unterminated string in filter");
}

/** Comparison operator at `i` (longest match first). */
function lexOperator(
	input: string,
	i: number,
): { token: Token; next: number } | undefined {
	const two = input.slice(i, i + 2);
	if (two === "!=" || two === "<=" || two === ">=")
		return { token: { t: "op", op: two }, next: i + 2 };
	const c = input[i];
	if (c === "=" || c === "<" || c === ">" || c === ":")
		return { token: { t: "op", op: c }, next: i + 1 };
	return undefined;
}

/** Bare word at `i`: keyword (AND/OR/NOT), field path, or number. */
function lexWord(
	input: string,
	i: number,
): { token: Token; next: number } | undefined {
	const c = input[i];
	if (c !== "-" && !isWordChar(c)) return undefined;
	let j = i;
	let w = "";
	while (j < input.length && (isWordChar(input[j]) || input[j] === ".")) {
		w += input[j];
		j++;
	}
	if (w === "-" || w.startsWith(".") || w.endsWith(".") || w.includes(".."))
		throw new FilterError(`malformed token '${w}' in filter`);
	if (w === "AND") return { token: { t: "and" }, next: j };
	if (w === "OR") return { token: { t: "or" }, next: j };
	if (w === "NOT") return { token: { t: "not" }, next: j };
	return { token: { t: "value", v: w }, next: j };
}

// ---- parser (recursive descent; OR binds loosest, NOT tightest) ----

class Parser {
	private pos = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly fields: FieldMap,
	) {}

	parseExpr(): Expr {
		return this.parseOr();
	}

	private peekIs(tok: Token): boolean {
		const p = this.tokens[this.pos];
		if (!p) return false;
		return Object.keys(tok).every((k) => p[k] === tok[k]);
	}

	expectEnd(): void {
		if (this.pos < this.tokens.length)
			throw new FilterError("unexpected trailing token in filter");
	}

	private parseOr(): Expr {
		let left = this.parseAnd();
		while (this.peekIs({ t: "or" })) {
			this.pos++;
			left = { kind: "andor", op: "OR", left, right: this.parseAnd() };
		}
		return left;
	}

	private parseAnd(): Expr {
		let left = this.parseNot();
		while (this.peekIs({ t: "and" })) {
			this.pos++;
			left = { kind: "andor", op: "AND", left, right: this.parseNot() };
		}
		return left;
	}

	private parseNot(): Expr {
		if (this.peekIs({ t: "not" })) {
			this.pos++;
			return { kind: "not", inner: this.parseNot() };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): Expr {
		if (this.peekIs({ t: "lp" })) {
			this.pos++;
			const inner = this.parseOr();
			if (!this.peekIs({ t: "rp" })) throw new FilterError("missing )");
			this.pos++;
			return inner;
		}
		return this.parseComparison();
	}

	/** field (dot-path) op value — the leaf. */
	private parseComparison(): Expr {
		const fieldTok = this.tokens[this.pos];
		if (!fieldTok || fieldTok.t !== "value")
			throw new FilterError("expected a field name in filter");
		this.pos++;
		const opTok = this.tokens[this.pos];
		if (!opTok || opTok.t !== "op")
			throw new FilterError(`expected an operator after '${fieldTok.v}'`);
		this.pos++;
		const valTok = this.tokens[this.pos];
		if (!valTok || valTok.t !== "value")
			throw new FilterError(`expected a value after '${opTok.op}'`);
		this.pos++;
		return { kind: "cmp", cmp: this.resolveField(fieldTok.v, opTok.op, valTok.v) };
	}

	/**
	 * Validate the field's root against the FieldMap: unknown root =
	 * FilterError naming it; a dot-path on a non-JSON field is refused the
	 * same way (the column has no nested shape to address).
	 */
	private resolveField(raw: string, op: CompareOp, value: string): Comparison {
		const segs = raw.split(".");
		const field = segs[0];
		const spec = this.fields[field];
		if (!spec) throw new FilterError(`unknown filter field '${field}'`, field);
		const path = segs.slice(1);
		if (path.length > 0 && !spec.json)
			throw new FilterError(`field '${field}' has no nested fields`, field);
		return { field, path, op, value };
	}
}

// ---- SQL emitter ----

/** SQL-quote a JSON path segment ('' for embedded single quotes). */
function jsonQuote(seg: string): string {
	return `$.${seg.replaceAll("'", "''")}`;
}

class Emitter {
	private readonly params: SqlParam[] = [];

	constructor(private readonly fields: FieldMap) {}

	emit(expr: Expr): SqlFragment {
		return { sql: this.expr(expr), params: this.params };
	}

	private expr(e: Expr): string {
		switch (e.kind) {
			case "not":
				return `NOT (${this.expr(e.inner)})`;
			case "andor":
				return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
			case "cmp":
				return this.comparison(e.cmp);
		}
	}

	private comparison(c: Comparison): string {
		const spec = this.fields[c.field];
		const lhs = this.lhs(c.field, c.path, spec);
		if (c.op === ":") return `${lhs} LIKE ?${this.push(likePattern(c.value))}`;
		const op = c.op === "!=" ? "<>" : c.op;
		return `${lhs} ${op} ?${this.push(bindValue(c.value, spec))}`;
	}

	private push(p: SqlParam): string {
		this.params.push(p);
		return "";
	}

	/** Left-hand SQL for a field: column, or json_extract into a dot-path. */
	private lhs(field: string, path: string[], spec: FieldSpec): string {
		if (path.length === 0) return spec.column;
		const inner = path.map(jsonQuote).join("");
		return `json_extract(${spec.column}, '${inner}')`;
	}
}

/** `foo` → `%foo%` for the `:` contains operator (plain LIKE, no ESCAPE). */
function likePattern(value: string): string {
	return `%${value}%`;
}

/**
 * Numeric columns bind as numbers (a non-numeric value on one is a
 * FilterError — comparing a number column to text is a caller bug, and
 * SQLite's loose affinity would otherwise answer silently wrong).
 */
function bindValue(value: string, spec: FieldSpec): SqlParam {
	if (!spec.numeric) return value;
	const n = Number(value);
	if (value.trim() === "" || Number.isNaN(n))
		throw new FilterError(`expected a number, got '${value}'`);
	return n;
}

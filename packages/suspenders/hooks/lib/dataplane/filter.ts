// filter.ts — W2327 ALIGNMENT COPY of W2326's module (their item owns it;
// the C186 interface contract, implemented so the service builds before
// their branch lands). Merge rule: take THEIRS for this file. Contract:
// parseFilter(filter, fields) => { sql, params } — a WHERE fragment (no
// WHERE prefix), parameterized values only; FieldMap = Record<string,
// { column, json?, numeric? }>; json fields accept dot-paths
// (payload.kind -> json_extract(col, '$.kind')); unknown field throws
// FilterError carrying .field. Operators: = != < > <= >= : (contains via
// LIKE), AND/OR/NOT, parentheses. AIP-160 subset, scalars only.
export interface SqlFragment {
	sql: string;
	params: unknown[];
}

export interface FilterField {
	column: string;
	json?: boolean;
	numeric?: boolean;
}

export type FieldMap = Record<string, FilterField>;

export class FilterError extends Error {
	constructor(
		readonly field: string,
		message: string,
	) {
		super(message);
		this.name = "FilterError";
	}
}

type Token =
	| { t: "lp" }
	| { t: "rp" }
	| { t: "and" }
	| { t: "or" }
	| { t: "not" }
	| { t: "op"; v: string }
	| { t: "val"; v: string }
	| { t: "ident"; v: string };

const OPS = ["!=", "<=", ">=", "=", "<", ">", ":"];

const lex = (src: string): Token[] | null => {
	const out: Token[] = [];
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "(") {
			out.push({ t: "lp" });
			i++;
			continue;
		}
		if (c === ")") {
			out.push({ t: "rp" });
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			const j = src.indexOf(c, i + 1);
			if (j === -1) return null;
			out.push({ t: "val", v: src.slice(i + 1, j) });
			i = j + 1;
			continue;
		}
		const rest = src.slice(i);
		const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
		if (word) {
			const up = word[0].toUpperCase();
			if (up === "AND") out.push({ t: "and" });
			else if (up === "OR") out.push({ t: "or" });
			else if (up === "NOT") out.push({ t: "not" });
			else out.push({ t: "ident", v: word[0] });
			i += word[0].length;
			continue;
		}
		const op = OPS.find((o) => rest.startsWith(o));
		if (op) {
			out.push({ t: "op", v: op });
			i += op.length;
			continue;
		}
		// bare scalar value (number or unquoted word on the RHS)
		const scalar = /^[^\s()]+/.exec(rest);
		if (!scalar) return null;
		out.push({ t: "val", v: scalar[0] });
		i += scalar[0].length;
	}
	return out;
};

const expr = (col: string, field: FilterField, op: string, value: string) => {
	if (field.json && field.column.includes(".")) {
		// json:true + dot-path column: payload.kind -> json_extract($.kind)
		const [tbl, ...path] = field.column.split(".");
		col = `json_extract(${tbl}, '$.${path.join(".")}')`;
	}
	return { col, field, op, value };
};

export function parseFilter(filter: string, fields: FieldMap): SqlFragment {
	const tokens = lex(filter);
	if (!tokens || tokens.length === 0)
		throw new FilterError("", "empty or unlexable filter");
	let pos = 0;
	const params: unknown[] = [];

	const peek = (): Token | undefined => tokens[pos];
	const next = (): Token | undefined => tokens[pos++];

	const scalarOf = (tok: Token | undefined, field: string): string => {
		if (!tok || (tok.t !== "val" && tok.t !== "ident"))
			throw new FilterError(field, `expected a value for '${field}'`);
		return tok.v;
	};

	const term = (): string => {
		const tok = next();
		if (!tok) throw new FilterError("", "unexpected end of filter");
		if (tok.t === "lp") {
			const inner = orExpr();
			if (next()?.t !== "rp") throw new FilterError("", "missing )");
			return `(${inner})`;
		}
		if (tok.t === "not") return `(NOT ${term()})`;
		if (tok.t !== "ident") throw new FilterError("", "expected a field");
		const def = fields[tok.v];
		if (!def) throw new FilterError(tok.v, `unknown filter field: ${tok.v}`);
		const op = next();
		if (op?.t !== "op")
			throw new FilterError(tok.v, `expected an operator after '${tok.v}'`);
		const raw = scalarOf(next(), tok.v);
		const { col } = expr(def.column, def, op.v, raw);
		const param = def.numeric ? Number(raw) : raw;
		if (def.numeric && !Number.isFinite(param as number))
			throw new FilterError(tok.v, `'${raw}' is not numeric`);
		params.push(op.v === ":" ? `%${raw}%` : param);
		if (op.v === ":") return `${col} LIKE ?`;
		if (op.v === "!=") return `${col} != ?`;
		return `${col} ${op.v} ?`;
	};

	const andExpr = (): string => {
		let left = term();
		while (peek()?.t === "and") {
			next();
			left += ` AND ${term()}`;
		}
		return left;
	};

	const orExpr = (): string => {
		let left = andExpr();
		while (peek()?.t === "or") {
			next();
			left += ` OR ${andExpr()}`;
		}
		return left;
	};

	const sql = orExpr();
	if (pos !== tokens.length)
		throw new FilterError("", "trailing tokens in filter");
	return { sql, params };
}

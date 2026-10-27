// Preserve shell word spans until redirections have been removed. shell-quote
// alone cannot distinguish `2>out` (fd) from `2 >out` (a real argv word).
const boundary = (c: string | undefined): boolean =>
	c === undefined || /[\s;|&()<>]/.test(c);

function wordEnd(source: string, start: number): number {
	let quote = "";
	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (c === "\\" && quote !== "'") {
			if (++i >= source.length) throw Error("unfinished shell escape");
			continue;
		}
		if (quote === "'") {
			if (c === "'") quote = "";
			continue;
		}
		if (c === "$" || c === "`")
			throw Error("dynamic shell words cannot prove push arguments");
		if (quote === '"') {
			if (c === '"') quote = "";
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (boundary(c)) return i;
	}
	if (quote) throw Error("unfinished shell quote");
	return source.length;
}

/** Only syntactic redirection spans disappear; quoted/escaped operators and
 * numeric argv remain exact. Here-docs, substitutions and incomplete syntax
 * are unsupported and fail closed instead of inventing a push refspec. */
export function withoutPushRedirections(source: string): string {
	const spans: Array<[number, number]> = [];
	let previousWord: { start: number; end: number } | null = null;
	for (let i = 0; i < source.length; ) {
		const c = source[i];
		const redirect =
			c === ">" || c === "<" || (c === "&" && source[i + 1] === ">");
		if (!redirect) {
			if (boundary(c)) {
				i++;
				previousWord = null;
			} else {
				const end = wordEnd(source, i);
				previousWord = { start: i, end };
				i = end;
			}
			continue;
		}
		if (source.startsWith("<<", i))
			throw Error("here-document push arguments are unsupported");
		const start =
			c !== "&" &&
			previousWord?.end === i &&
			/^\d+$/.test(source.slice(previousWord.start, i))
				? previousWord.start
				: i;
		const op = ["&>>", "&>", ">>", ">|", ">&", "<&", "<>", ">", "<"].find(
			(value) => source.startsWith(value, i),
		);
		if (!op) throw Error("unresolved redirection");
		i += op.length;
		while (source[i] === " " || source[i] === "\t") i++;
		const end = wordEnd(source, i);
		if (end === i) throw Error("missing redirection operand");
		spans.push([start, end]);
		i = end;
		previousWord = null;
	}
	let result = "";
	let offset = 0;
	for (const [start, end] of spans) {
		result += `${source.slice(offset, start)} `;
		offset = end;
	}
	return result + source.slice(offset);
}

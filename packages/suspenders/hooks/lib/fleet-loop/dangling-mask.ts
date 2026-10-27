// dangling-mask.ts — W1302.8: the tokenizer behind the dangling-path classifier.
// Comments are blanked; every string, template and regex body becomes a
// sentinel-wrapped index into `strings`, so call-shape rules match real code
// only — never text that merely sits inside a string or a comment. Template
// holes are scanned as code, so a call inside `${...}` stays visible.

export type Strings = (string | null)[];
export type Masked = { code: string; strings: Strings };
type Scan = { code: string; end: number };

// private-use characters never occur in source
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
export const STR = `${OPEN}([0-9]+)${CLOSE}`;
export const STR_ALL = new RegExp(STR, "g");

// a slash opens a regex literal after these; after an identifier, number,
// `)` or `]` it divides
const REGEX_AFTER =
	/(?:^|[(,=:[!&|?{;+*%<>~^-]|(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await))\s*$/;

function push(strings: Strings, raw: string | null): string {
	strings.push(raw);
	return `${OPEN}${strings.length - 1}${CLOSE}`;
}

function lineEnd(s: string, i: number): number {
	const nl = s.indexOf("\n", i);
	return nl < 0 ? s.length : nl;
}

// index just past the comment opening at i; -1 when none opens there
function commentEnd(s: string, i: number): number {
	if (s.charAt(i) !== "/") return -1;
	if (s.charAt(i + 1) === "/") return lineEnd(s, i);
	if (s.charAt(i + 1) !== "*") return -1;
	const close = s.indexOf("*/", i + 2);
	return close < 0 ? s.length : close + 2;
}

// index just past the closing quote; an unterminated string ends at its line
function quotedEnd(s: string, i: number): number {
	const quote = s.charAt(i);
	let j = i + 1;
	while (j < s.length && s.charAt(j) !== quote && s.charAt(j) !== "\n")
		j += s.charAt(j) === "\\" ? 2 : 1;
	return j + 1;
}

// -1 when the line holds no closing slash: the slash was a division
function regexEnd(s: string, i: number): number {
	let inClass = false;
	for (let j = i + 1; j < s.length && s.charAt(j) !== "\n"; j++) {
		const c = s.charAt(j);
		if (c === "\\") {
			j++;
		} else if (c === "[") {
			inClass = true;
		} else if (c === "]") {
			inClass = false;
		} else if (c === "/" && !inClass) {
			let k = j + 1;
			while (/[a-z]/i.test(s.charAt(k))) k++;
			return k;
		}
	}
	return -1;
}

function regexAt(s: string, i: number, before: string): number {
	if (s.charAt(i) !== "/" || !REGEX_AFTER.test(before.slice(-24))) return -1;
	return regexEnd(s, i);
}

// the static text becomes one string (null when the template has holes); each
// hole is scanned as code
function scanTemplate(src: string, from: number, strings: Strings): Scan {
	let holeCode = "";
	let holes = 0;
	let j = from + 1;
	while (j < src.length && src.charAt(j) !== "`") {
		if (src.charAt(j) === "$" && src.charAt(j + 1) === "{") {
			const hole = scan(src, j + 2, strings, true);
			holeCode += ` ${hole.code} `;
			holes += 1;
			j = hole.end;
		} else {
			j += src.charAt(j) === "\\" ? 2 : 1;
		}
	}
	const raw = holes > 0 ? null : src.slice(from + 1, j);
	return { code: push(strings, raw) + holeCode, end: j + 1 };
}

// code outside strings, comments and regexes is kept verbatim; inside a hole
// the scan stops after the brace that closes it
function scan(
	src: string,
	from: number,
	strings: Strings,
	inHole: boolean,
): Scan {
	let code = "";
	let depth = 0;
	let i = from;
	while (i < src.length) {
		const c = src.charAt(i);
		const comment = commentEnd(src, i);
		const regex = comment < 0 ? regexAt(src, i, code) : -1;
		if (comment > i) {
			code += " ";
			i = comment;
		} else if (c === "'" || c === '"') {
			const end = quotedEnd(src, i);
			code += push(strings, src.slice(i + 1, end - 1));
			i = end;
		} else if (c === "`") {
			const tpl = scanTemplate(src, i, strings);
			code += tpl.code;
			i = tpl.end;
		} else if (regex > i) {
			code += push(strings, null);
			i = regex;
		} else if (inHole && c === "}" && depth === 0) {
			return { code, end: i + 1 };
		} else {
			if (c === "{") depth += 1;
			if (c === "}") depth -= 1;
			code += c;
			i += 1;
		}
	}
	return { code, end: src.length };
}

export function maskCode(src: string): Masked {
	const strings: Strings = [];
	return { code: scan(src, 0, strings, false).code, strings };
}

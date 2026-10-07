import { stripVTControlCharacters } from "node:util";

/** Parse the work-show header and owner field; descriptions are not state. */
export function isResumableClaim(
	output: string,
	item: string,
	sid: string,
): boolean {
	const lines = stripVTControlCharacters(output).trim().split("\n");
	const header = /^\S+\s+(\S+)\s+(CLAIMED|RUNNING)(?:\s|$)/.exec(
		lines[0] ?? "",
	);
	if (!header || header[1] !== item) return false;
	const owner = lines
		.map((line) => /^\s+owner_sid:\s*(\S+)\s*$/.exec(line))
		.find((match) => match !== null);
	return owner?.[1] === sid;
}

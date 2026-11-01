// cursor.ts — W2327: opaque keyset pagination (AIP-158). The token is
// base64url JSON of the sort-key tuple the collection orders by; List
// decodes it into a strict `after` predicate the SQL appends. Not a
// security boundary — opaque to clients, never signed, but validated:
// a malformed token is invalid_argument, never a 500.
const enc = (v: string): string => Buffer.from(v, "utf8").toString("base64url");

const dec = (v: string): string | null => {
	try {
		return Buffer.from(v, "base64url").toString("utf8");
	} catch {
		return null;
	}
};

/** Encode a cursor from an ordered tuple of primitive sort values. */
export const encodeCursor = (tuple: (string | number | null)[]): string =>
	enc(JSON.stringify(tuple));

/** Decode a cursor back to its tuple; null when malformed for the length. */
export const decodeCursor = (
	token: string,
	width: number,
): (string | number | null)[] | null => {
	const raw = dec(token);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length !== width) return null;
		if (
			!parsed.every(
				(v) =>
					v === null ||
					typeof v === "string" ||
					(typeof v === "number" && Number.isFinite(v)),
			)
		)
			return null;
		return parsed as (string | number | null)[];
	} catch {
		return null;
	}
};

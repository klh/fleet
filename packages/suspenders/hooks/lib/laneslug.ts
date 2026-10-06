// hooks/lib/laneslug.ts — the ONE derivation of a lane sid from a work label
// (W460). Label grammar is W<digits>(.<digits>)* — minted by work.ts only.
// Dots map to '-' (a char the grammar never emits), so the mapping is
// injective: W1.23 and W12.3 no longer collapse to the same sid. Dotless
// labels keep the legacy output byte-for-byte — live lane names don't break.
export const laneSid = (item: string): string =>
	`autow${item.replace(/^W/, "").replace(/\./g, "-")}`;

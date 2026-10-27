// tests/helpers/p1-findings.pin.ts — W1303.1.5: shrink-only pin of the P1
// guards' known findings (check-p1.ts --write-pin re-stamps it from the
// live run). A row excuses ONE finding shape on one package: the actual
// finding's prefix must start with the row's prefix. Remove a row when its
// finding is fixed upstream; a new finding fails the gate until it is
// either fixed or deliberately re-stamped in the same landing.
export type P1Check = "versions" | "deps" | "pack";

export interface P1PinRow {
	check: P1Check;
	/** package the row is scoped to (dir name, no @klh/ prefix) */
	pkg: string;
	/** the excused finding's stable prefix (startsWith match) */
	prefix: string;
}

export const P1_PIN: readonly P1PinRow[] = [];

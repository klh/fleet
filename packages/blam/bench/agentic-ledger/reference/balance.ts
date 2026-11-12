/**
 * Ledger reconciliation: opening balance + posted entries → reconciled balance.
 *
 * Entry kinds: "debit" and "credit" carry a signed amount (debit negative,
 * credit positive). "refund" entries REVERSE an earlier debit: their raw
 * amount is stored as recorded by the payment provider (positive number)
 * and must INCREASE the balance. Entries at or before `pendingCutoffTs`
 * are settled; entries strictly after it are pending and excluded.
 */

export type EntryKind = "debit" | "credit" | "refund";

export interface LedgerEntry {
	id: string;
	kind: EntryKind;
	/** Raw stored amount; see kind rules above. */
	amount: number;
	ts: number;
}

export interface ReconciledBalance {
	settled: number;
	pending: number;
}

export function reconcileBalance(
	entries: LedgerEntry[],
	openingBalance: number,
	pendingCutoffTs: number,
): ReconciledBalance {
	let settled = openingBalance;
	let pending = 0;
	for (const e of entries) {
		const signed =
			e.kind === "debit"
				? -e.amount
				: e.kind === "credit"
					? e.amount
					: e.amount; // refund: provider records it positive; it reverses a debit
		if (e.ts <= pendingCutoffTs) {
			settled += signed;
		} else {
			pending += signed;
		}
	}
	return { settled, pending };
}

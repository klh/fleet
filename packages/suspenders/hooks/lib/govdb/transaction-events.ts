/** Rows inserted inside a transaction become publishable only after COMMIT.
 * Transaction objects, not reusable client IDs, own the pending batch. */
export class TransactionEvents {
	private readonly pending = new WeakMap<object, Set<number>>();
	constructor(
		private readonly publish: (id: number) => void,
		private readonly failed = (id: number, error: unknown): void => {
			console.error(
				"[store] committed event push failed",
				id,
				error instanceof Error ? error.name : "unknown",
			);
		},
	) {}
	inserted(transaction: object | null, id: number): void {
		if (!transaction) {
			this.publishCommitted(id);
			return;
		}
		let ids = this.pending.get(transaction);
		if (!ids) {
			ids = new Set();
			this.pending.set(transaction, ids);
		}
		ids.add(id);
	}
	finish(transaction: object, committed: boolean): void {
		const ids = this.pending.get(transaction);
		this.pending.delete(transaction);
		if (!committed || !ids) return;
		for (const id of [...ids].sort((a, b) => a - b)) this.publishCommitted(id);
	}
	private publishCommitted(id: number): void {
		try {
			this.publish(id);
		} catch (error) {
			try {
				this.failed(id, error);
			} catch {
				/* Reporting cannot invalidate a durable commit. */
			}
		}
	}
}

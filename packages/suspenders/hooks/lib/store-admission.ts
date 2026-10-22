/** This refusal is issued before SQL execution. Only this explicit receipt
 * permits retrying a mutation; transport failures never prove nonexecution. */
export const STORE_TX_BUSY = "store_tx_busy";
export const storeAdmissionRefusal = () => ({
	err: "a transaction is open — retry",
	code: STORE_TX_BUSY,
	executed: false,
});
export class StoreAdmissionError extends Error {}
export const isStoreAdmissionRefusal = (body: {
	code?: unknown;
	executed?: unknown;
}): boolean => body.code === STORE_TX_BUSY && body.executed === false;

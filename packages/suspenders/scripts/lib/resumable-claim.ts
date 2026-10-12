/** Only structured graph state and exact ownership authorize a resume. */
export function isResumableClaim(
	output: string,
	item: string,
	sid: string,
): boolean {
	try {
		const row = JSON.parse(output);
		return (
			row !== null &&
			typeof row === "object" &&
			!Array.isArray(row) &&
			row.id === item &&
			row.owner_sid === sid &&
			(row.state === "CLAIMED" || row.state === "RUNNING")
		);
	} catch {
		return false;
	}
}

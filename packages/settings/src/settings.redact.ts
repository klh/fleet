/** Public diagnostics never provide a second credential-reading interface. */
export function redactSettings(
	value: unknown,
	path: readonly string[] = [],
): unknown {
	const name = path.at(-1) ?? "";
	if (
		/^(?:key|api_key|token|password|secret|authorization|credential)$|(?:_key|_token|_password|_secret)$/i.test(
			name,
		)
	)
		return value === undefined || value === null ? value : "<redacted>";
	if (Array.isArray(value))
		return value.map((entry) => redactSettings(entry, path));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				redactSettings(child, [...path, key]),
			]),
		);
	return value;
}

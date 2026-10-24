// bench/w1219/prompt.ts — the shared NL→SQL prompt. One format for all
// candidates (the sqlcoder task shape): schema, rules, question, fenced
// SQL-only answer. Identical prompt = the A/B measures the MODEL, not the
// prompt. temperature 0 everywhere.
export function buildPrompt(schemaText: string, question: string): string {
	return [
		`-- bench: ${crypto.randomUUID()}`,
		"### Task",
		"Generate a SQL query to answer the following question:",
		`\`${question}\``,
		"### Database Schema",
		schemaText,
		"### Rules",
		"1. Answer with ONE SQLite SELECT statement and nothing else.",
		"2. Never write, only read: no INSERT/UPDATE/DELETE/DDL.",
		"3. Wrap the query in a ```sql fence.",
		"### Answer",
		"Given the database schema, here is the SQL query that answers the question:",
		"```sql",
	].join("\n");
}

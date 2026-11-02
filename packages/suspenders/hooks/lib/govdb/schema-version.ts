// hooks/lib/govdb/schema-version.ts — the governor.db schema tip (W2551).
// One named constant instead of the largest `if (uv < N)` literal, so the
// --version face (hooks/lib/cli-version.ts) renders the live schema version
// without importing the whole migration ladder. govdb-open.ts owns the
// ladder and bumps PRAGMA user_version UP TO this constant LAST — a new
// migration step raises the constant and adds its own `if (uv < N)` block.
export const GOVDB_SCHEMA_VERSION = 19;

// hooks/lib/dataplane/types.ts — W2326: shared shapes for the dataplane
// filter parser (and the modules W2327/W2328 layer on top of it).

/** A bound parameter value — only these types ever reach SQLite. */
export type SqlParam = string | number;

/** A parameterized SQL fragment: `sql` carries `?` placeholders only. */
export interface SqlFragment {
	sql: string;
	params: SqlParam[];
}

/**
 * One filterable field. `column` is the trusted SQL column name (from the
 * service's own field map, never user input). `json: true` marks a TEXT
 * column holding JSON — dot-paths in the filter address into it via
 * json_extract. `numeric: true` columns bind unquoted values as numbers.
 */
export interface FieldSpec {
	column: string;
	json?: boolean;
	numeric?: boolean;
}

/** The service-declared filter vocabulary: filter field → column spec. */
export type FieldMap = Record<string, FieldSpec>;

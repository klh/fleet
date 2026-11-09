import { ALL_SCOPES, hasScope } from "@klh/buckle/src/gov/scopes.ts";
import { expect, test } from "@playwright/test";

test("runner permissions use canonical WRITE-implies-READ without proxy privilege @unit", () => {
	expect(ALL_SCOPES).toContain("buckle:runner:READ_");
	expect(ALL_SCOPES).toContain("buckle:runner:WRITE_");
	expect(hasScope(["buckle:runner:WRITE_"], "buckle:runner:READ_")).toBe(true);
	expect(hasScope(["buckle:runner:READ_"], "buckle:runner:WRITE_")).toBe(false);
	expect(hasScope(["buckle:proxy:WRITE_"], "buckle:runner:WRITE_")).toBe(false);
});

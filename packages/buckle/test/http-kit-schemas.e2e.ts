// test/http-kit-schemas.e2e.ts — W2173.7 zod-first: ProblemInit/FieldError
// are schema-defined (schema = THE definition, types derived); the
// HttpProblem class consumes the derived ProblemInit.
import { expect, test } from "@playwright/test";
import {
	type FieldError,
	FieldErrorSchema,
	HttpProblem,
	type ProblemInit,
	ProblemInitSchema,
} from "../src/http-kit.ts";

test.describe("ProblemInit/FieldError schemas (W2173.7) @unit", () => {
	test("valid init parses; the class carries kind/status/code", () => {
		const p = new HttpProblem("validation", {
			code: "buckle.idempotency_body_mismatch",
			why: "body changed",
			fields: [{ field: "model", why: "required" }],
		});
		expect(p.status).toBe(422);
		expect(p.code).toBe("buckle.idempotency_body_mismatch");
		expect(
			ProblemInitSchema.safeParse({
				code: "x.y",
				why: "z",
				fields: [{ field: "a", why: "b" }],
			}).success,
		).toBe(true);
	});

	test("empty code or why refuses; derived types flow", () => {
		expect(ProblemInitSchema.safeParse({ code: "", why: "z" }).success).toBe(
			false,
		);
		const init: ProblemInit = {
			code: "x.y",
			why: "z",
			retryAfterS: 5,
			next: ["retry"],
		};
		expect(init.code).toBe("x.y");
		const fe: FieldError = { field: "model", why: "missing" };
		expect(FieldErrorSchema.safeParse(fe).success).toBe(true);
		expect(FieldErrorSchema.safeParse({ field: "", why: "b" }).success).toBe(
			false,
		);
	});
});

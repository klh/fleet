// lane-done-spend.test.ts — W1070: the self-reported spend stamp producer
// tests (parse --spend, stamp the done payload, replay it back out).
import { expect, test } from "@playwright/test";
import {
	doneSpendStamp,
	parseDoneSpend,
	spendFromDonePayload,
} from "../hooks/lib/lanes/lane-done-spend.ts";
test.describe("@unit", () => {

test.describe("parseDoneSpend", () => {
	test("parses the documented k=v comma set", () => {
		expect(
			parseDoneSpend("fresh=123,cache=4560,out=789,model=glm-5.3-flash"),
		).toEqual({
			fresh: 123,
			cached: 4560,
			out: 789,
			model: "glm-5.3-flash",
		});
	});
	test("aliases fold into canonical fields", () => {
		expect(
			parseDoneSpend("input=10,prompt=5,cached=2,cache_read=3,output=1"),
		).toEqual({
			fresh: 15,
			cached: 5,
			out: 1,
			model: "",
		});
	});
	test("absent/empty/spend-free input → null", () => {
		expect(parseDoneSpend(null)).toBeNull();
		expect(parseDoneSpend(undefined)).toBeNull();
		expect(parseDoneSpend("")).toBeNull();
		expect(parseDoneSpend("model=glm-5.3-flash")).toBeNull(); // no numeric spend
		expect(parseDoneSpend("nonsense")).toBeNull();
	});
	test("negative/garbage numbers refuse; integers only", () => {
		expect(parseDoneSpend("fresh=-5,out=1")).toEqual({
			fresh: 0,
			cached: 0,
			out: 1,
			model: "",
		});
		expect(parseDoneSpend("fresh=1.5,out=1")?.fresh).toBe(0);
		expect(parseDoneSpend("fresh=abc,out=2")?.fresh).toBe(0);
	});
	test("model truncates at 24 chars", () => {
		expect(
			parseDoneSpend("out=1,model=01234567890123456789012345x")?.model,
		).toBe("012345678901234567890123");
	});
});

test.describe("doneSpendStamp / spendFromDonePayload", () => {
	test("stamp spreads the payload fragment; null → {}", () => {
		expect(doneSpendStamp(null)).toEqual({});
		expect(
			doneSpendStamp({ fresh: 10, cached: 20, out: 3, model: "glm-5.3-flash" }),
		).toEqual({
			spendFresh: 10,
			spendCached: 20,
			spendOut: 3,
			spendModel: "glm-5.3-flash",
		});
		expect(
			doneSpendStamp({ fresh: 10, cached: 0, out: 3, model: "" }).spendModel,
		).toBeUndefined(); // unnamed group stays absent
	});
	test("replay round-trips the stamp; garbage degrades to 0/null", () => {
		expect(
			spendFromDonePayload({
				spendFresh: 10,
				spendCached: 20,
				spendOut: 3,
				spendModel: "glm-5.3-flash",
			}),
		).toEqual({ fresh: 10, cached: 20, out: 3, model: "glm-5.3-flash" });
		expect(spendFromDonePayload({})).toBeNull();
		expect(spendFromDonePayload({ spendFresh: -1, spendOut: 5 })).toEqual({
			fresh: 0,
			cached: 0,
			out: 5,
			model: "",
		});
		expect(spendFromDonePayload({ spendFresh: "10" })).toBeNull(); // string, not number
	});
});

});

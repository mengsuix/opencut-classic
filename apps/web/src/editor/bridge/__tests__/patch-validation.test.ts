import { describe, expect, test } from "bun:test";
import { validateElementPatchRootKeys } from "../patch-validation";

describe("validateElementPatchRootKeys", () => {
	test("accepts params and time fields", () => {
		expect(() =>
			validateElementPatchRootKeys({
				params: { "transform.positionX": 120, "transform.positionY": 680 },
				startTime: 1.5,
				hidden: false,
			}),
		).not.toThrow();
	});

	test("rejects nested transform object at element root", () => {
		expect(() =>
			validateElementPatchRootKeys({
				transform: { position: { x: 120, y: 680 } },
			}),
		).toThrow(/transform\.positionX/);
	});

	test("rejects root-level x/y and names all unknown fields", () => {
		expect(() =>
			validateElementPatchRootKeys({ x: 120, y: 680 }),
		).toThrow(/x, y/);
	});

	test("accepts empty patch", () => {
		expect(() => validateElementPatchRootKeys({})).not.toThrow();
	});
});

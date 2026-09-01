import { describe, expect, mock, test } from "bun:test";

// `bun test` cannot load the wasm bundle; mock the integer-tick helpers before
// the dynamic imports below (same pattern as group-resize tests).
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1000,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
}));

const {
	buildMaskParamPath,
	isMaskParamPath,
	parseMaskParamPath,
	removeMaskParamKeyframe,
	resolveMaskParamsAtTime,
} = await import("@/animation/mask-param-channel");

import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import type { MediaTime } from "@/wasm";

function key(id: string, time: number, value: number): ScalarAnimationKey {
	return {
		id,
		time: time as MediaTime,
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

const staticParams = {
	centerX: 0,
	centerY: 0.5,
	width: 0.6,
	height: 0.6,
	rotation: 0,
	scale: 1,
	feather: 0,
	inverted: false,
	strokeColor: "#ffffff",
	strokeWidth: 0,
	strokeAlign: "center" as const,
};

describe("mask param paths", () => {
	test("builds, detects and parses paths", () => {
		const path = buildMaskParamPath({ maskId: "m1", paramKey: "centerX" });
		expect(path).toBe("masks.m1.params.centerX");
		expect(isMaskParamPath(path)).toBe(true);
		expect(isMaskParamPath("effects.e1.params.centerX")).toBe(false);
		expect(isMaskParamPath("transform.positionX")).toBe(false);
		expect(parseMaskParamPath({ propertyPath: path })).toEqual({
			maskId: "m1",
			paramKey: "centerX",
		});
		expect(parseMaskParamPath({ propertyPath: "masks..params.x" })).toBeNull();
		expect(parseMaskParamPath({ propertyPath: "masks.m1.params." })).toBeNull();
	});
});

describe("resolveMaskParamsAtTime", () => {
	const animations: ElementAnimations = {
		"masks.m1.params.centerX": {
			keys: [key("a", 0, 0), key("b", 10, 1)],
		},
	};

	test("resolves animated params and keeps static ones", () => {
		const resolved = resolveMaskParamsAtTime({
			maskId: "m1",
			params: staticParams,
			animations,
			localTime: 5,
		});
		expect(resolved.centerX).toBe(0.5);
		expect(resolved.centerY).toBe(0.5);
		expect(resolved.inverted).toBe(false);
		expect(resolved.strokeColor).toBe("#ffffff");
	});

	test("ignores animations of other masks", () => {
		const resolved = resolveMaskParamsAtTime({
			maskId: "m2",
			params: staticParams,
			animations,
			localTime: 5,
		});
		expect(resolved.centerX).toBe(0);
	});

	test("returns static params without animations", () => {
		const resolved = resolveMaskParamsAtTime({
			maskId: "m1",
			params: staticParams,
			animations: undefined,
			localTime: 5,
		});
		expect(resolved).toEqual(staticParams);
	});
});

describe("removeMaskParamKeyframe", () => {
	test("removes a keyframe by id", () => {
		const animations: ElementAnimations = {
			"masks.m1.params.centerX": {
				keys: [key("a", 0, 0)],
			},
		};
		expect(
			removeMaskParamKeyframe({
				animations,
				maskId: "m1",
				paramKey: "centerX",
				keyframeId: "a",
			}),
		).toBeUndefined();
	});
});

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
	getSourceSecondsAtClipSeconds,
	getSourceTimeAtClipTime,
	hasTimeRemap,
	TIME_REMAP_PATH,
} = await import("../resolve");
const { shiftTimeRemapChannelValues } = await import("../split");

import type {
	ElementAnimations,
	ScalarAnimationKey,
} from "@/animation/types";
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

// 2s clip maps to 4s of source: a constant 2x ramp expressed as a remap curve.
const rampAnimations: ElementAnimations = {
	[TIME_REMAP_PATH]: { keys: [key("a", 0, 0), key("b", 2000, 4)] },
};

describe("hasTimeRemap", () => {
	test("detects a non-empty remap channel", () => {
		expect(hasTimeRemap({ animations: rampAnimations })).toBe(true);
		expect(hasTimeRemap({ animations: {} })).toBe(false);
		expect(hasTimeRemap({ animations: undefined })).toBe(false);
		expect(
			hasTimeRemap({ animations: { [TIME_REMAP_PATH]: { keys: [] } } }),
		).toBe(false);
	});
});

describe("getSourceTimeAtClipTime with remap (tick domain)", () => {
	test("interpolates the curve and returns ticks", () => {
		expect(
			getSourceTimeAtClipTime({ clipTime: 1000, animations: rampAnimations }),
		).toBe(2000);
		expect(
			getSourceTimeAtClipTime({ clipTime: 2000, animations: rampAnimations }),
		).toBe(4000);
	});

	test("constant rate still applies when no remap channel exists", () => {
		expect(
			getSourceTimeAtClipTime({ clipTime: 5, retime: { rate: 2 } }),
		).toBe(10);
		expect(getSourceTimeAtClipTime({ clipTime: 5 })).toBe(5);
	});

	test("decreasing values produce reverse playback", () => {
		const reverse: ElementAnimations = {
			[TIME_REMAP_PATH]: { keys: [key("a", 0, 4), key("b", 2000, 0)] },
		};
		expect(
			getSourceTimeAtClipTime({ clipTime: 1000, animations: reverse }),
		).toBe(2000);
	});
});

describe("getSourceSecondsAtClipSeconds (audio domain)", () => {
	test("returns seconds and evaluates the curve at tick-converted time", () => {
		expect(
			getSourceSecondsAtClipSeconds({
				clipSeconds: 1,
				animations: rampAnimations,
			}),
		).toBe(2);
	});

	test("falls back to constant rate without remap", () => {
		expect(
			getSourceSecondsAtClipSeconds({
				clipSeconds: 1,
				retime: { rate: 0.5 },
			}),
		).toBe(0.5);
	});
});

describe("shiftTimeRemapChannelValues", () => {
	test("shifts values by the offset and clamps at zero", () => {
		const shifted = shiftTimeRemapChannelValues({
			animations: rampAnimations,
			offsetSeconds: -3,
		});
		const channel = shifted?.[TIME_REMAP_PATH];
		expect(channel).toBeDefined();
		expect(
			channel && "keys" in channel && Array.isArray(channel.keys)
				? (channel.keys as ScalarAnimationKey[]).map((k) => k.value)
				: [],
		).toEqual([0, 1]);
	});

	test("leaves animations without a remap channel untouched", () => {
		const animations: ElementAnimations = {
			opacity: { keys: [key("a", 0, 1)] },
		};
		expect(
			shiftTimeRemapChannelValues({ animations, offsetSeconds: 1 }),
		).toBe(animations);
	});
});

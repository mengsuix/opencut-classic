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

const { getScalarChannelValueAtTime } = await import("@/animation/interpolation");
const { setChannelLoop } = await import("@/animation/keyframes");

import type { ScalarAnimationChannel, ScalarAnimationKey } from "@/animation/types";
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

const loopingChannel: ScalarAnimationChannel = {
	keys: [key("a", 0, 0), key("b", 10, 10)],
	extrapolation: { before: "loop", after: "loop" },
};

describe("loop extrapolation", () => {
	test("wraps time after the last key into the cycle", () => {
		expect(
			getScalarChannelValueAtTime({
				channel: loopingChannel,
				time: 15,
				fallbackValue: 0,
			}),
		).toBe(5);
		expect(
			getScalarChannelValueAtTime({
				channel: loopingChannel,
				time: 27,
				fallbackValue: 0,
			}),
		).toBe(7);
	});

	test("lands on the first key value at exact cycle boundaries", () => {
		expect(
			getScalarChannelValueAtTime({
				channel: loopingChannel,
				time: 20,
				fallbackValue: 0,
			}),
		).toBe(0);
	});

	test("wraps time before the first key", () => {
		expect(
			getScalarChannelValueAtTime({
				channel: loopingChannel,
				time: -3,
				fallbackValue: 0,
			}),
		).toBe(7);
	});

	test("in-range time is unaffected", () => {
		expect(
			getScalarChannelValueAtTime({
				channel: loopingChannel,
				time: 10,
				fallbackValue: 0,
			}),
		).toBe(10);
	});

	test("default hold extrapolation is unchanged", () => {
		const holdChannel: ScalarAnimationChannel = {
			keys: [key("a", 0, 0), key("b", 10, 10)],
		};
		expect(
			getScalarChannelValueAtTime({
				channel: holdChannel,
				time: 15,
				fallbackValue: 0,
			}),
		).toBe(10);
	});

	test("single-key channel is safe under loop", () => {
		const singleKey: ScalarAnimationChannel = {
			keys: [key("a", 5, 3)],
			extrapolation: { before: "loop", after: "loop" },
		};
		expect(
			getScalarChannelValueAtTime({
				channel: singleKey,
				time: 99,
				fallbackValue: 0,
			}),
		).toBe(3);
	});
});

describe("setChannelLoop", () => {
	test("sets loop extrapolation on a scalar channel", () => {
		const animations = setChannelLoop({
			animations: { opacity: { keys: [key("a", 0, 1), key("b", 10, 0.3)] } },
			propertyPath: "opacity",
			loop: true,
		});
		const channel = animations?.opacity as ScalarAnimationChannel;
		expect(channel.extrapolation).toEqual({ before: "loop", after: "loop" });
		expect(channel.keys).toHaveLength(2);
	});

	test("disabling loop restores hold extrapolation", () => {
		const animations = setChannelLoop({
			animations: { opacity: loopingChannel },
			propertyPath: "opacity",
			loop: false,
		});
		const channel = animations?.opacity as ScalarAnimationChannel;
		expect(channel.extrapolation).toEqual({ before: "hold", after: "hold" });
	});

	test("returns animations unchanged for an unknown path", () => {
		const source = { opacity: { keys: [key("a", 0, 1)] } };
		expect(
			setChannelLoop({
				animations: source,
				propertyPath: "volume",
				loop: true,
			}),
		).toBe(source);
	});
});

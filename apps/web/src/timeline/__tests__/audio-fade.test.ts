import { describe, expect, test } from "bun:test";
import { hasAudioFade, readAudioFades, resolveFadeGain } from "../audio-fade";

describe("readAudioFades", () => {
	test("defaults to zero when params are missing", () => {
		expect(readAudioFades({ params: {} })).toEqual({ fadeIn: 0, fadeOut: 0 });
	});

	test("reads configured values", () => {
		expect(readAudioFades({ params: { fadeIn: 0.5, fadeOut: 1 } })).toEqual({
			fadeIn: 0.5,
			fadeOut: 1,
		});
	});

	test("treats non-number and negative values as disabled", () => {
		expect(readAudioFades({ params: { fadeIn: "0.5", fadeOut: -1 } })).toEqual({
			fadeIn: 0,
			fadeOut: 0,
		});
	});
});

describe("hasAudioFade", () => {
	test("false when both are zero", () => {
		expect(hasAudioFade({ fadeIn: 0, fadeOut: 0 })).toBe(false);
	});

	test("true when either side is set", () => {
		expect(hasAudioFade({ fadeIn: 0.5, fadeOut: 0 })).toBe(true);
		expect(hasAudioFade({ fadeIn: 0, fadeOut: 0.5 })).toBe(true);
	});
});

describe("resolveFadeGain", () => {
	test("no fades keeps full gain", () => {
		expect(
			resolveFadeGain({
				fadeIn: 0,
				fadeOut: 0,
				localTimeSeconds: 1,
				durationSeconds: 4,
			}),
		).toBe(1);
	});

	test("fade in ramps linearly from zero", () => {
		expect(
			resolveFadeGain({
				fadeIn: 1,
				fadeOut: 0,
				localTimeSeconds: 0,
				durationSeconds: 4,
			}),
		).toBe(0);
		expect(
			resolveFadeGain({
				fadeIn: 1,
				fadeOut: 0,
				localTimeSeconds: 0.5,
				durationSeconds: 4,
			}),
		).toBeCloseTo(0.5);
		expect(
			resolveFadeGain({
				fadeIn: 1,
				fadeOut: 0,
				localTimeSeconds: 2,
				durationSeconds: 4,
			}),
		).toBe(1);
	});

	test("fade out ramps down to zero at the end", () => {
		expect(
			resolveFadeGain({
				fadeIn: 0,
				fadeOut: 1,
				localTimeSeconds: 4,
				durationSeconds: 4,
			}),
		).toBe(0);
		expect(
			resolveFadeGain({
				fadeIn: 0,
				fadeOut: 1,
				localTimeSeconds: 3.5,
				durationSeconds: 4,
			}),
		).toBeCloseTo(0.5);
		expect(
			resolveFadeGain({
				fadeIn: 0,
				fadeOut: 1,
				localTimeSeconds: 1,
				durationSeconds: 4,
			}),
		).toBe(1);
	});

	test("overlapping fades multiply", () => {
		expect(
			resolveFadeGain({
				fadeIn: 2,
				fadeOut: 2,
				localTimeSeconds: 1,
				durationSeconds: 2,
			}),
		).toBeCloseTo(0.25);
	});
});

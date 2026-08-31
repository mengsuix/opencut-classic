import { describe, expect, test } from "bun:test";
import { buildVisualAnimConfig, resolveVisualAnimAtTime } from "../visual-anim";

const CANVAS = { canvasWidth: 1920, canvasHeight: 1080 };

describe("buildVisualAnimConfig", () => {
	test("defaults to none when params are missing", () => {
		expect(buildVisualAnimConfig({ params: {}, phase: "in" })).toEqual({
			type: "none",
			duration: 0.5,
		});
		expect(buildVisualAnimConfig({ params: {}, phase: "out" })).toEqual({
			type: "none",
			duration: 0.5,
		});
	});

	test("falls back to none for unknown type values", () => {
		expect(
			buildVisualAnimConfig({
				params: { "animIn.type": "spiral", "animIn.duration": 2 },
				phase: "in",
			}),
		).toEqual({ type: "none", duration: 2 });
	});

	test("reads the phase-specific keys", () => {
		expect(
			buildVisualAnimConfig({
				params: { "animOut.type": "slide-left", "animOut.duration": 1.5 },
				phase: "out",
			}),
		).toEqual({ type: "slide-left", duration: 1.5 });
	});
});

describe("resolveVisualAnimAtTime", () => {
	test("none type and non-positive duration stay idle", () => {
		const idle = { opacityFactor: 1, scaleFactor: 1, offsetX: 0, offsetY: 0 };
		expect(
			resolveVisualAnimAtTime({
				animIn: { type: "none", duration: 1 },
				localTime: 0.2,
				elementDuration: 5,
				...CANVAS,
			}),
		).toEqual(idle);
		expect(
			resolveVisualAnimAtTime({
				animIn: { type: "fade", duration: 0 },
				localTime: 0.2,
				elementDuration: 5,
				...CANVAS,
			}),
		).toEqual(idle);
	});

	test("fade in ramps opacity linearly", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "fade", duration: 1 },
			localTime: 0.5,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.opacityFactor).toBeCloseTo(0.5);
		expect(state.scaleFactor).toBe(1);
	});

	test("fade out ramps opacity down near the end", () => {
		const state = resolveVisualAnimAtTime({
			animOut: { type: "fade", duration: 1 },
			localTime: 4.5,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.opacityFactor).toBeCloseTo(0.5);
	});

	test("fade out is idle before the out window", () => {
		const state = resolveVisualAnimAtTime({
			animOut: { type: "fade", duration: 1 },
			localTime: 2,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.opacityFactor).toBe(1);
	});

	test("pop in settles at full scale", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "pop", duration: 0.5 },
			localTime: 2,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.scaleFactor).toBe(1);
	});

	test("pop in starts near zero scale", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "pop", duration: 0.5 },
			localTime: 0,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.scaleFactor).toBeLessThan(0.01);
	});

	test("zoom in starts larger and fades in", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "zoom", duration: 1 },
			localTime: 0,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.scaleFactor).toBeCloseTo(1.5);
		expect(state.opacityFactor).toBeCloseTo(0);
	});

	test("zoom out ends larger and faded out", () => {
		const state = resolveVisualAnimAtTime({
			animOut: { type: "zoom", duration: 1 },
			localTime: 5,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.scaleFactor).toBeCloseTo(1.5);
		expect(state.opacityFactor).toBeCloseTo(0);
	});

	test("slide-left in enters from the right edge", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "slide-left", duration: 1 },
			localTime: 0,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.offsetX).toBeCloseTo(CANVAS.canvasWidth);
		expect(state.offsetY).toBe(0);
	});

	test("slide-left out exits towards the left edge", () => {
		const state = resolveVisualAnimAtTime({
			animOut: { type: "slide-left", duration: 1 },
			localTime: 5,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.offsetX).toBeCloseTo(-CANVAS.canvasWidth);
	});

	test("slide-up in enters from below", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "slide-up", duration: 1 },
			localTime: 0,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.offsetY).toBeCloseTo(CANVAS.canvasHeight);
	});

	test("slide-up out exits upwards", () => {
		const state = resolveVisualAnimAtTime({
			animOut: { type: "slide-up", duration: 1 },
			localTime: 5,
			elementDuration: 5,
			...CANVAS,
		});
		expect(state.offsetY).toBeCloseTo(-CANVAS.canvasHeight);
	});

	test("overlapping in and out compose multiplicatively", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "fade", duration: 2 },
			animOut: { type: "fade", duration: 2 },
			localTime: 1,
			elementDuration: 2,
			...CANVAS,
		});
		expect(state.opacityFactor).toBeCloseTo(0.25);
	});

	test("progress clamps beyond the anim window", () => {
		const state = resolveVisualAnimAtTime({
			animIn: { type: "fade", duration: 1 },
			localTime: 99,
			elementDuration: 200,
			...CANVAS,
		});
		expect(state.opacityFactor).toBe(1);
	});
});

import { describe, expect, test } from "bun:test";
import {
	buildTransitionFromParams,
	computeTrackTransitions,
	isActiveTransition,
	resolveTransitionIncoming,
	resolveTransitionOutgoing,
} from "../transition";

const CANVAS_WIDTH = 1920;

describe("buildTransitionFromParams", () => {
	test("defaults to none when params are missing", () => {
		expect(buildTransitionFromParams({ params: {} })).toEqual({
			type: "none",
			duration: 0.5,
		});
	});

	test("falls back to none for unknown type values", () => {
		expect(
			buildTransitionFromParams({
				params: { "transition.type": "spiral", "transition.duration": 2 },
			}),
		).toEqual({ type: "none", duration: 2 });
	});

	test("reads configured type and duration", () => {
		const config = buildTransitionFromParams({
			params: { "transition.type": "fade", "transition.duration": 1 },
		});
		expect(config).toEqual({ type: "fade", duration: 1 });
		expect(isActiveTransition(config)).toBe(true);
	});
});

describe("resolveTransitionOutgoing", () => {
	test("fade keeps the outgoing element untouched", () => {
		expect(resolveTransitionOutgoing({ type: "fade", progress: 0.5 })).toEqual({
			opacityFactor: 1,
			scaleFactor: 1,
			offsetX: 0,
			offsetY: 0,
		});
	});

	test("black fades outgoing out over the first half", () => {
		expect(
			resolveTransitionOutgoing({ type: "black", progress: 0.25 })
				.opacityFactor,
		).toBeCloseTo(0.5);
		expect(
			resolveTransitionOutgoing({ type: "black", progress: 0.75 })
				.opacityFactor,
		).toBe(0);
	});

	test("zoom scales up and fades out", () => {
		const state = resolveTransitionOutgoing({ type: "zoom", progress: 0.5 });
		expect(state.opacityFactor).toBeCloseTo(0.5);
		expect(state.scaleFactor).toBeCloseTo(1.15);
	});
});

describe("resolveTransitionIncoming", () => {
	test("fade ramps incoming opacity", () => {
		expect(
			resolveTransitionIncoming({
				type: "fade",
				progress: 0.5,
				canvasWidth: CANVAS_WIDTH,
			}).opacityFactor,
		).toBeCloseTo(0.5);
	});

	test("black fades incoming in over the second half", () => {
		expect(
			resolveTransitionIncoming({
				type: "black",
				progress: 0.25,
				canvasWidth: CANVAS_WIDTH,
			}).opacityFactor,
		).toBe(0);
		expect(
			resolveTransitionIncoming({
				type: "black",
				progress: 0.75,
				canvasWidth: CANVAS_WIDTH,
			}).opacityFactor,
		).toBeCloseTo(0.5);
	});

	test("zoom scales down and fades in", () => {
		const state = resolveTransitionIncoming({
			type: "zoom",
			progress: 0.5,
			canvasWidth: CANVAS_WIDTH,
		});
		expect(state.opacityFactor).toBeCloseTo(0.5);
		expect(state.scaleFactor).toBeCloseTo(1.15);
	});

	test("slide-left enters from the right edge", () => {
		expect(
			resolveTransitionIncoming({
				type: "slide-left",
				progress: 0,
				canvasWidth: CANVAS_WIDTH,
			}).offsetX,
		).toBeCloseTo(CANVAS_WIDTH);
		expect(
			resolveTransitionIncoming({
				type: "slide-left",
				progress: 1,
				canvasWidth: CANVAS_WIDTH,
			}).offsetX,
		).toBe(0);
	});

	test("slide-right enters from the left edge", () => {
		expect(
			resolveTransitionIncoming({
				type: "slide-right",
				progress: 0,
				canvasWidth: CANVAS_WIDTH,
			}).offsetX,
		).toBeCloseTo(-CANVAS_WIDTH);
	});
});

describe("computeTrackTransitions", () => {
	const buildElement = ({
		id,
		startTime,
		duration,
		params = {},
	}: {
		id: string;
		startTime: number;
		duration: number;
		params?: Record<string, string | number>;
	}) => ({ id, startTime, duration, params });

	test("assigns out and in to adjacent elements", () => {
		const assignments = computeTrackTransitions({
			elements: [
				buildElement({
					id: "a",
					startTime: 0,
					duration: 120_000,
					params: { "transition.type": "fade", "transition.duration": 0.5 },
				}),
				buildElement({ id: "b", startTime: 120_000, duration: 120_000 }),
			],
			maxGapTicks: 4000,
		});
		expect(assignments.get("a")?.transitionOut).toEqual({
			type: "fade",
			duration: 0.5,
		});
		expect(assignments.get("b")?.transitionIn).toEqual({
			type: "fade",
			duration: 0.5,
		});
	});

	test("ignores elements with a gap larger than the threshold", () => {
		const assignments = computeTrackTransitions({
			elements: [
				buildElement({
					id: "a",
					startTime: 0,
					duration: 120_000,
					params: { "transition.type": "fade", "transition.duration": 0.5 },
				}),
				buildElement({ id: "b", startTime: 240_000, duration: 120_000 }),
			],
			maxGapTicks: 4000,
		});
		expect(assignments.size).toBe(0);
	});

	test("ignores inactive transitions", () => {
		const assignments = computeTrackTransitions({
			elements: [
				buildElement({
					id: "a",
					startTime: 0,
					duration: 120_000,
					params: { "transition.type": "none" },
				}),
				buildElement({ id: "b", startTime: 120_000, duration: 120_000 }),
			],
			maxGapTicks: 4000,
		});
		expect(assignments.size).toBe(0);
	});

	test("chains transitions across three elements", () => {
		const assignments = computeTrackTransitions({
			elements: [
				buildElement({
					id: "a",
					startTime: 0,
					duration: 120_000,
					params: { "transition.type": "fade" },
				}),
				buildElement({
					id: "b",
					startTime: 120_000,
					duration: 120_000,
					params: { "transition.type": "zoom", "transition.duration": 1 },
				}),
				buildElement({ id: "c", startTime: 240_000, duration: 120_000 }),
			],
			maxGapTicks: 4000,
		});
		expect(assignments.get("b")?.transitionIn).toEqual({
			type: "fade",
			duration: 0.5,
		});
		expect(assignments.get("b")?.transitionOut).toEqual({
			type: "zoom",
			duration: 1,
		});
		expect(assignments.get("c")?.transitionIn).toEqual({
			type: "zoom",
			duration: 1,
		});
	});
});

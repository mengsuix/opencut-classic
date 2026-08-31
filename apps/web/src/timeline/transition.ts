import type { ParamValues } from "@/params";
import {
	combineVisualAnimStates,
	type VisualAnimState,
} from "@/animation/visual-anim";
import { clamp } from "@/utils/math";
import { readNumberParam, readStringParam } from "@/text/param-readers";

/**
 * Built-in transitions between two adjacent same-track elements. Pure logic
 * with second/tick-explicit inputs so the module stays loadable where the
 * wasm runtime is unavailable (bun test).
 *
 * Semantics: the outgoing element keeps its content timeline and plays an
 * "out" animation over its last `duration` seconds; the incoming element's
 * visible range extends left by `duration` (video consumes trimStart
 * handles, falling back to a held first frame; images extend naturally).
 */

const FALLBACK_TRANSITION_TYPE: TransitionType = "none";
const FALLBACK_TRANSITION_DURATION = 0.5;

export type TransitionType =
	| "none"
	| "fade"
	| "black"
	| "zoom"
	| "slide-left"
	| "slide-right";

export const TRANSITION_TYPES: readonly TransitionType[] = [
	"none",
	"fade",
	"black",
	"zoom",
	"slide-left",
	"slide-right",
];

export interface TransitionConfig {
	type: TransitionType;
	/** Seconds. */
	duration: number;
}

export function buildTransitionFromParams({
	params,
}: {
	params: ParamValues;
}): TransitionConfig {
	const rawType = readStringParam({
		params,
		key: "transition.type",
		fallback: FALLBACK_TRANSITION_TYPE,
	});
	const type = TRANSITION_TYPES.find((known) => known === rawType) ?? "none";
	const duration = readNumberParam({
		params,
		key: "transition.duration",
		fallback: FALLBACK_TRANSITION_DURATION,
	});
	return { type, duration };
}

export function isActiveTransition(config: TransitionConfig): boolean {
	return config.type !== "none" && config.duration > 0;
}

const IDLE_STATE: VisualAnimState = {
	opacityFactor: 1,
	scaleFactor: 1,
	offsetX: 0,
	offsetY: 0,
};

/** Animation factors applied to the outgoing (front) element. */
export function resolveTransitionOutgoing({
	type,
	progress,
}: {
	type: TransitionType;
	progress: number;
}): VisualAnimState {
	const p = clamp({ value: progress, min: 0, max: 1 });
	switch (type) {
		case "fade":
			return IDLE_STATE;
		case "black":
			// First half: outgoing fades to black; then stays at zero.
			return {
				...IDLE_STATE,
				opacityFactor: clamp({ value: 1 - 2 * p, min: 0, max: 1 }),
			};
		case "zoom":
			return {
				...IDLE_STATE,
				opacityFactor: 1 - p,
				scaleFactor: 1 + 0.3 * p,
			};
		case "slide-left":
		case "slide-right":
			return IDLE_STATE;
		default:
			return IDLE_STATE;
	}
}

/** Animation factors applied to the incoming (rear) element. */
export function resolveTransitionIncoming({
	type,
	progress,
	canvasWidth,
}: {
	type: TransitionType;
	progress: number;
	canvasWidth: number;
}): VisualAnimState {
	const p = clamp({ value: progress, min: 0, max: 1 });
	switch (type) {
		case "fade":
			return { ...IDLE_STATE, opacityFactor: p };
		case "black":
			// Second half: incoming fades in from black.
			return {
				...IDLE_STATE,
				opacityFactor: clamp({ value: 2 * p - 1, min: 0, max: 1 }),
			};
		case "zoom":
			return {
				...IDLE_STATE,
				opacityFactor: p,
				scaleFactor: 1.3 - 0.3 * p,
			};
		case "slide-left":
			return {
				...IDLE_STATE,
				offsetX: (1 - p) * canvasWidth,
			};
		case "slide-right":
			return {
				...IDLE_STATE,
				offsetX: -(1 - p) * canvasWidth,
			};
		default:
			return IDLE_STATE;
	}
}

/**
 * Combined transition animation factors for one element at a given time.
 * All times are in ticks; `ticksPerSecond` converts the second-based
 * transition durations.
 */
export function resolveElementTransitionAtTime({
	transitionIn,
	transitionOut,
	time,
	timeOffset,
	duration,
	canvasWidth,
	ticksPerSecond,
}: {
	transitionIn?: TransitionConfig;
	transitionOut?: TransitionConfig;
	time: number;
	timeOffset: number;
	duration: number;
	canvasWidth: number;
	ticksPerSecond: number;
}): VisualAnimState {
	let state = IDLE_STATE;

	if (transitionOut && isActiveTransition(transitionOut)) {
		const durationTicks = transitionOut.duration * ticksPerSecond;
		const progress =
			(time - (timeOffset + duration - durationTicks)) / durationTicks;
		if (progress > 0) {
			state = combineVisualAnimStates({
				a: state,
				b: resolveTransitionOutgoing({
					type: transitionOut.type,
					progress,
				}),
			});
		}
	}

	if (transitionIn && isActiveTransition(transitionIn)) {
		const durationTicks = transitionIn.duration * ticksPerSecond;
		const progress = (time - (timeOffset - durationTicks)) / durationTicks;
		if (progress < 1) {
			state = combineVisualAnimStates({
				a: state,
				b: resolveTransitionIncoming({
					type: transitionIn.type,
					progress,
					canvasWidth,
				}),
			});
		}
	}

	return state;
}

/** Left extension of the visible range for an element with transitionIn. */
export function transitionLeadInTicks({
	transitionIn,
	ticksPerSecond,
}: {
	transitionIn?: TransitionConfig;
	ticksPerSecond: number;
}): number {
	return transitionIn && isActiveTransition(transitionIn)
		? transitionIn.duration * ticksPerSecond
		: 0;
}

export interface TrackTransitionAssignment {
	transitionIn?: TransitionConfig;
	transitionOut?: TransitionConfig;
}

/**
 * Walk one track's sorted elements and assign transitions: an element with
 * an active `transition.*` param drives the transition into the next
 * element when they are adjacent (gap within `maxGapTicks`).
 */
export function computeTrackTransitions({
	elements,
	maxGapTicks,
}: {
	elements: Array<{
		id: string;
		startTime: number;
		duration: number;
		params: ParamValues;
	}>;
	maxGapTicks: number;
}): Map<string, TrackTransitionAssignment> {
	const assignments = new Map<string, TrackTransitionAssignment>();
	for (let i = 0; i < elements.length - 1; i++) {
		const current = elements[i];
		const next = elements[i + 1];
		const config = buildTransitionFromParams({ params: current.params });
		if (!isActiveTransition(config)) {
			continue;
		}
		const gap = next.startTime - (current.startTime + current.duration);
		if (gap < 0 || gap > maxGapTicks) {
			continue;
		}
		const currentAssignment = assignments.get(current.id) ?? {};
		currentAssignment.transitionOut = config;
		assignments.set(current.id, currentAssignment);
		const nextAssignment = assignments.get(next.id) ?? {};
		nextAssignment.transitionIn = config;
		assignments.set(next.id, nextAssignment);
	}
	return assignments;
}

import type { ParamValues } from "@/params";
import { clamp } from "@/utils/math";
import { readNumberParam, readStringParam } from "@/text/param-readers";

/**
 * Entrance/exit animation presets for non-text visual elements
 * (video/image/sticker/graphic). Pure logic with second-based inputs so the
 * module stays loadable where the wasm runtime is unavailable (bun test).
 */

const FALLBACK_ANIM_TYPE: VisualAnimType = "none";
const FALLBACK_ANIM_DURATION = 0.5;

export type VisualAnimType =
	| "none"
	| "fade"
	| "pop"
	| "zoom"
	| "slide-up"
	| "slide-down"
	| "slide-left"
	| "slide-right";

export const VISUAL_ANIM_TYPES: readonly VisualAnimType[] = [
	"none",
	"fade",
	"pop",
	"zoom",
	"slide-up",
	"slide-down",
	"slide-left",
	"slide-right",
];

export type VisualAnimPhase = "in" | "out";

export interface VisualAnimConfig {
	type: VisualAnimType;
	/** Seconds. */
	duration: number;
}

export interface VisualAnimState {
	opacityFactor: number;
	scaleFactor: number;
	offsetX: number;
	offsetY: number;
}

const IDLE_ANIM_STATE: VisualAnimState = {
	opacityFactor: 1,
	scaleFactor: 1,
	offsetX: 0,
	offsetY: 0,
};

export function buildVisualAnimConfig({
	params,
	phase,
}: {
	params: ParamValues;
	phase: VisualAnimPhase;
}): VisualAnimConfig {
	const prefix = phase === "in" ? "animIn" : "animOut";
	const rawType = readStringParam({
		params,
		key: `${prefix}.type`,
		fallback: FALLBACK_ANIM_TYPE,
	});
	const type = VISUAL_ANIM_TYPES.find((known) => known === rawType) ?? "none";
	const duration = readNumberParam({
		params,
		key: `${prefix}.duration`,
		fallback: FALLBACK_ANIM_DURATION,
	});
	return { type, duration };
}

const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;

function easeOutBack(t: number): number {
	return 1 + BACK_C3 * (t - 1) ** 3 + BACK_C1 * (t - 1) ** 2;
}

function easeOutQuad(t: number): number {
	return 1 - (1 - t) * (1 - t);
}

function easeInQuad(t: number): number {
	return t * t;
}

/** Unit vector of the slide motion direction. */
const SLIDE_DIRECTIONS: Record<string, { x: number; y: number }> = {
	"slide-up": { x: 0, y: -1 },
	"slide-down": { x: 0, y: 1 },
	"slide-left": { x: -1, y: 0 },
	"slide-right": { x: 1, y: 0 },
};

type CanvasSize = { canvasWidth: number; canvasHeight: number };

function resolveInState({
	config,
	progress,
	canvas,
}: {
	config: VisualAnimConfig;
	progress: number;
	canvas: CanvasSize;
}): VisualAnimState {
	switch (config.type) {
		case "fade":
			return { ...IDLE_ANIM_STATE, opacityFactor: progress };
		case "pop":
			return {
				...IDLE_ANIM_STATE,
				scaleFactor: Math.max(easeOutBack(progress), 0.0001),
			};
		case "zoom": {
			const eased = easeOutQuad(progress);
			return {
				...IDLE_ANIM_STATE,
				opacityFactor: eased,
				scaleFactor: 1.5 - 0.5 * eased,
			};
		}
		case "slide-up":
		case "slide-down":
		case "slide-left":
		case "slide-right": {
			const dir = SLIDE_DIRECTIONS[config.type];
			const remaining = 1 - easeOutQuad(progress);
			return {
				...IDLE_ANIM_STATE,
				offsetX: -dir.x * remaining * canvas.canvasWidth,
				offsetY: -dir.y * remaining * canvas.canvasHeight,
			};
		}
		default:
			return IDLE_ANIM_STATE;
	}
}

function resolveOutState({
	config,
	progress,
	canvas,
}: {
	config: VisualAnimConfig;
	/** Exit progress 0..1 (0 = fully shown, 1 = fully gone). */
	progress: number;
	canvas: CanvasSize;
}): VisualAnimState {
	switch (config.type) {
		case "fade":
			return { ...IDLE_ANIM_STATE, opacityFactor: 1 - progress };
		case "pop":
			return {
				...IDLE_ANIM_STATE,
				scaleFactor: Math.max(easeOutBack(1 - progress), 0.0001),
			};
		case "zoom": {
			const eased = easeInQuad(progress);
			return {
				...IDLE_ANIM_STATE,
				opacityFactor: 1 - eased,
				scaleFactor: 1 + 0.5 * eased,
			};
		}
		case "slide-up":
		case "slide-down":
		case "slide-left":
		case "slide-right": {
			const dir = SLIDE_DIRECTIONS[config.type];
			const eased = easeInQuad(progress);
			return {
				...IDLE_ANIM_STATE,
				offsetX: dir.x * eased * canvas.canvasWidth,
				offsetY: dir.y * eased * canvas.canvasHeight,
			};
		}
		default:
			return IDLE_ANIM_STATE;
	}
}

function combineStates({
	a,
	b,
}: {
	a: VisualAnimState;
	b: VisualAnimState;
}): VisualAnimState {
	return {
		opacityFactor: a.opacityFactor * b.opacityFactor,
		scaleFactor: a.scaleFactor * b.scaleFactor,
		offsetX: a.offsetX + b.offsetX,
		offsetY: a.offsetY + b.offsetY,
	};
}

/**
 * All times in seconds. `localTime` is relative to element start;
 * `elementDuration` is the full element duration.
 */
export function resolveVisualAnimAtTime({
	animIn,
	animOut,
	localTime,
	elementDuration,
	canvasWidth,
	canvasHeight,
}: {
	animIn?: VisualAnimConfig;
	animOut?: VisualAnimConfig;
	localTime: number;
	elementDuration: number;
	canvasWidth: number;
	canvasHeight: number;
}): VisualAnimState {
	const canvas = { canvasWidth, canvasHeight };
	let state = IDLE_ANIM_STATE;

	if (animIn && animIn.type !== "none" && animIn.duration > 0) {
		const progress = clamp({
			value: localTime / animIn.duration,
			min: 0,
			max: 1,
		});
		state = combineStates({
			a: state,
			b: resolveInState({ config: animIn, progress, canvas }),
		});
	}

	if (animOut && animOut.type !== "none" && animOut.duration > 0) {
		const remaining = elementDuration - localTime;
		const progress = clamp({
			value: 1 - remaining / animOut.duration,
			min: 0,
			max: 1,
		});
		state = combineStates({
			a: state,
			b: resolveOutState({ config: animOut, progress, canvas }),
		});
	}

	return state;
}

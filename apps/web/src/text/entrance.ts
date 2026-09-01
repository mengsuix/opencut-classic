import type { TextElement } from "@/timeline";
import { clamp } from "@/utils/math";
import { readNumberParam, readStringParam } from "./param-readers";

// Fallbacks mirror DEFAULTS.text.animIn/animOut/animLoop; kept local so this
// module stays loadable where the wasm runtime is unavailable (bun test).
const FALLBACK_ENTRANCE_TYPE: TextEntranceType = "none";
const FALLBACK_ENTRANCE_DURATION = 0.5;
const FALLBACK_LOOP_TYPE: TextLoopType = "none";
const FALLBACK_LOOP_DURATION = 1;

export type TextEntranceType =
	| "none"
	| "fade"
	| "pop"
	| "typewriter"
	| "fade-chars"
	| "pop-chars";

export const TEXT_ENTRANCE_TYPES: readonly TextEntranceType[] = [
	"none",
	"fade",
	"pop",
	"typewriter",
	"fade-chars",
	"pop-chars",
];

export type TextLoopType = "none" | "pulse" | "blink" | "shake";

export const TEXT_LOOP_TYPES: readonly TextLoopType[] = [
	"none",
	"pulse",
	"blink",
	"shake",
];

export type TextAnimPhase = "in" | "out";

export interface TextEntranceConfig {
	type: TextEntranceType;
	/** Seconds from element start (in) or before element end (out). */
	duration: number;
}

export interface TextEntranceState {
	opacityFactor: number;
	scaleFactor: number;
	/** 0..1 fraction of characters visible; null when not truncating. */
	visibleRatio: number | null;
}

export interface TextLoopConfig {
	type: TextLoopType;
	/** Loop period in seconds. */
	duration: number;
}

export interface TextLoopState {
	opacityFactor: number;
	scaleFactor: number;
	/** Offsets as a fraction of canvas height; scaled by the caller. */
	offsetX: number;
	offsetY: number;
}

/** Peak shake displacement as a fraction of canvas height (~6.5px at 1080p). */
export const TEXT_SHAKE_AMPLITUDE = 0.006;

export function buildTextEntranceFromElement({
	element,
	phase = "in",
}: {
	element: TextElement;
	phase?: TextAnimPhase;
}): TextEntranceConfig {
	const prefix = phase === "in" ? "animIn" : "animOut";
	const rawType = readStringParam({
		params: element.params,
		key: `${prefix}.type`,
		fallback: FALLBACK_ENTRANCE_TYPE,
	});
	const type = TEXT_ENTRANCE_TYPES.find((known) => known === rawType) ?? "none";
	const duration = readNumberParam({
		params: element.params,
		key: `${prefix}.duration`,
		fallback: FALLBACK_ENTRANCE_DURATION,
	});
	return { type, duration };
}

export function buildTextLoopFromElement({
	element,
}: {
	element: TextElement;
}): TextLoopConfig {
	const rawType = readStringParam({
		params: element.params,
		key: "animLoop.type",
		fallback: FALLBACK_LOOP_TYPE,
	});
	const type = TEXT_LOOP_TYPES.find((known) => known === rawType) ?? "none";
	const duration = readNumberParam({
		params: element.params,
		key: "animLoop.duration",
		fallback: FALLBACK_LOOP_DURATION,
	});
	return { type, duration };
}

const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;

function easeOutBack(t: number): number {
	return 1 + BACK_C3 * (t - 1) ** 3 + BACK_C1 * (t - 1) ** 2;
}

export function resolveTextEntranceAtTime({
	config,
	localTime,
	phase = "in",
	elementDuration,
}: {
	config: TextEntranceConfig;
	localTime: number;
	phase?: TextAnimPhase;
	/** Seconds; required for the "out" phase. */
	elementDuration?: number;
}): TextEntranceState {
	const idle: TextEntranceState = {
		opacityFactor: 1,
		scaleFactor: 1,
		visibleRatio: null,
	};
	if (config.type === "none" || config.duration <= 0) {
		return idle;
	}
	if (phase === "out") {
		if (elementDuration === undefined) {
			return idle;
		}
		const remaining = elementDuration - localTime;
		const progress = clamp({
			value: 1 - remaining / config.duration,
			min: 0,
			max: 1,
		});
		switch (config.type) {
			case "fade":
				return { ...idle, opacityFactor: 1 - progress };
			case "pop":
				return {
					...idle,
					scaleFactor: Math.max(easeOutBack(1 - progress), 0.0001),
				};
			case "typewriter":
				return { ...idle, visibleRatio: 1 - progress };
			default:
				return idle;
		}
	}
	const progress = clamp({
		value: localTime / config.duration,
		min: 0,
		max: 1,
	});
	switch (config.type) {
		case "fade":
			return { ...idle, opacityFactor: progress };
		case "pop":
			return {
				...idle,
				scaleFactor: Math.max(easeOutBack(progress), 0.0001),
			};
		case "typewriter":
			return { ...idle, visibleRatio: progress };
		default:
			return idle;
	}
}

// ---------------------------------------------------------------------------
// Per-character animation ("fade-chars" / "pop-chars")
// ---------------------------------------------------------------------------

export interface TextCharAnimState {
	opacityFactor: number;
	scaleFactor: number;
}

export function isPerCharEntranceType(type: TextEntranceType): boolean {
	return type === "fade-chars" || type === "pop-chars";
}

/** Staggered per-char progress: char `index` sweeps 0→1 as the overall
 * progress passes its slot; the last char completes exactly at 1. */
export function getTextCharProgress({
	index,
	totalChars,
	overallProgress,
}: {
	index: number;
	totalChars: number;
	overallProgress: number;
}): number {
	if (totalChars <= 0) {
		return 1;
	}
	return clamp({
		value: overallProgress * totalChars - index,
		min: 0,
		max: 1,
	});
}

export function resolveTextCharAnim({
	type,
	phase,
	progress,
}: {
	type: TextEntranceType;
	phase: TextAnimPhase;
	progress: number;
}): TextCharAnimState {
	const shown = phase === "in" ? progress : 1 - progress;
	switch (type) {
		case "fade-chars":
			return { opacityFactor: shown, scaleFactor: 1 };
		case "pop-chars":
			return {
				opacityFactor: shown,
				scaleFactor: Math.max(easeOutBack(shown), 0.0001),
			};
		default:
			return { opacityFactor: 1, scaleFactor: 1 };
	}
}

/** Builds a per-char state resolver when either phase uses a per-char type;
 * returns null otherwise (the caller measures full content either way). */
export function buildTextCharStateAt({
	inConfig,
	outConfig,
	localTime,
	elementDuration,
	totalChars,
}: {
	inConfig?: TextEntranceConfig;
	outConfig?: TextEntranceConfig;
	localTime: number;
	elementDuration: number;
	totalChars: number;
}): ((index: number) => TextCharAnimState) | null {
	const inActive =
		inConfig != null &&
		isPerCharEntranceType(inConfig.type) &&
		inConfig.duration > 0;
	const outActive =
		outConfig != null &&
		isPerCharEntranceType(outConfig.type) &&
		outConfig.duration > 0;
	if (!inActive && !outActive) {
		return null;
	}

	const inOverall = inActive
		? clamp({ value: localTime / inConfig.duration, min: 0, max: 1 })
		: 1;
	const outOverall = outActive
		? clamp({
				value: 1 - (elementDuration - localTime) / outConfig.duration,
				min: 0,
				max: 1,
			})
		: 0;

	return (index) => {
		const inState = inActive
			? resolveTextCharAnim({
					type: inConfig.type,
					phase: "in",
					progress: getTextCharProgress({
						index,
						totalChars,
						overallProgress: inOverall,
					}),
				})
			: { opacityFactor: 1, scaleFactor: 1 };
		const outState = outActive
			? resolveTextCharAnim({
					type: outConfig.type,
					phase: "out",
					progress: getTextCharProgress({
						index,
						totalChars,
						overallProgress: outOverall,
					}),
				})
			: { opacityFactor: 1, scaleFactor: 1 };
		return {
			opacityFactor: inState.opacityFactor * outState.opacityFactor,
			scaleFactor: inState.scaleFactor * outState.scaleFactor,
		};
	};
}

export function resolveTextLoopAtTime({
	config,
	localTime,
}: {
	config: TextLoopConfig;
	localTime: number;
}): TextLoopState {
	const idle: TextLoopState = {
		opacityFactor: 1,
		scaleFactor: 1,
		offsetX: 0,
		offsetY: 0,
	};
	if (config.type === "none" || config.duration <= 0) {
		return idle;
	}
	const cycle = (((localTime / config.duration) % 1) + 1) % 1;
	const angle = cycle * Math.PI * 2;
	switch (config.type) {
		case "pulse":
			return { ...idle, scaleFactor: 1 + 0.05 * Math.sin(angle) };
		case "blink":
			return { ...idle, opacityFactor: 0.65 + 0.35 * Math.sin(angle) };
		case "shake":
			return {
				...idle,
				offsetX: TEXT_SHAKE_AMPLITUDE * Math.sin(angle * 3.3),
				offsetY: TEXT_SHAKE_AMPLITUDE * Math.sin(angle * 4.1 + 1.7),
			};
		default:
			return idle;
	}
}

export function countTextChars({ content }: { content: string }): number {
	let count = 0;
	for (const line of content.split("\n")) {
		count += Array.from(line).length;
	}
	return count;
}

export function truncateTextContent({
	content,
	visibleChars,
}: {
	content: string;
	visibleChars: number;
}): string {
	if (visibleChars <= 0) return "";
	const lines = content.split("\n");
	const out: string[] = [];
	let remaining = visibleChars;
	for (const line of lines) {
		const chars = Array.from(line);
		if (remaining >= chars.length) {
			out.push(line);
			remaining -= chars.length;
		} else {
			out.push(chars.slice(0, remaining).join(""));
			return out.join("\n");
		}
	}
	return out.join("\n");
}

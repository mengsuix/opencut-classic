import type { TextElement } from "@/timeline";
import { clamp } from "@/utils/math";
import { readNumberParam, readStringParam } from "./param-readers";

// Fallbacks mirror DEFAULTS.text.animIn; kept local so this module stays
// loadable where the wasm runtime is unavailable (bun test).
const FALLBACK_ENTRANCE_TYPE: TextEntranceType = "none";
const FALLBACK_ENTRANCE_DURATION = 0.5;

export type TextEntranceType = "none" | "fade" | "pop" | "typewriter";

export const TEXT_ENTRANCE_TYPES: readonly TextEntranceType[] = [
	"none",
	"fade",
	"pop",
	"typewriter",
];

export interface TextEntranceConfig {
	type: TextEntranceType;
	/** Seconds from element start. */
	duration: number;
}

export interface TextEntranceState {
	opacityFactor: number;
	scaleFactor: number;
	/** 0..1 fraction of characters visible; null when not truncating. */
	visibleRatio: number | null;
}

export function buildTextEntranceFromElement({
	element,
}: {
	element: TextElement;
}): TextEntranceConfig {
	const rawType = readStringParam({
		params: element.params,
		key: "animIn.type",
		fallback: FALLBACK_ENTRANCE_TYPE,
	});
	const type = TEXT_ENTRANCE_TYPES.find((known) => known === rawType) ?? "none";
	const duration = readNumberParam({
		params: element.params,
		key: "animIn.duration",
		fallback: FALLBACK_ENTRANCE_DURATION,
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
}: {
	config: TextEntranceConfig;
	localTime: number;
}): TextEntranceState {
	const idle: TextEntranceState = {
		opacityFactor: 1,
		scaleFactor: 1,
		visibleRatio: null,
	};
	if (config.type === "none" || config.duration <= 0) {
		return idle;
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

import type { ParamValues } from "@/params";
import { clamp } from "@/utils/math";

/**
 * Audio fade in/out as a linear gain ramp. Pure logic with second-based
 * inputs so the module stays loadable where the wasm runtime is unavailable
 * (bun test).
 */

export interface AudioFadeConfig {
	/** Seconds; 0 disables the fade. */
	fadeIn: number;
	/** Seconds; 0 disables the fade. */
	fadeOut: number;
}

export function readAudioFades({
	params,
}: {
	params: ParamValues;
}): AudioFadeConfig {
	const fadeIn = params.fadeIn;
	const fadeOut = params.fadeOut;
	return {
		fadeIn: typeof fadeIn === "number" && fadeIn > 0 ? fadeIn : 0,
		fadeOut: typeof fadeOut === "number" && fadeOut > 0 ? fadeOut : 0,
	};
}

export function hasAudioFade({ fadeIn, fadeOut }: AudioFadeConfig): boolean {
	return fadeIn > 0 || fadeOut > 0;
}

export function resolveFadeGain({
	fadeIn,
	fadeOut,
	localTimeSeconds,
	durationSeconds,
}: AudioFadeConfig & {
	localTimeSeconds: number;
	durationSeconds: number;
}): number {
	let gain = 1;
	if (fadeIn > 0) {
		gain *= clamp({ value: localTimeSeconds / fadeIn, min: 0, max: 1 });
	}
	if (fadeOut > 0) {
		gain *= clamp({
			value: (durationSeconds - localTimeSeconds) / fadeOut,
			min: 0,
			max: 1,
		});
	}
	return gain;
}

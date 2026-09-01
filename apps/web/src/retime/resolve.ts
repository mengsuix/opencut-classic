import type { ElementAnimations } from "@/animation/types";
import { getChannelsFromData } from "@/animation/channel-data";
import { resolveAnimationPathValueAtTime } from "@/animation/resolve";
import type { RetimeConfig } from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";
import { TICKS_PER_SECOND } from "@/wasm";

/**
 * Time remapping: a keyframe channel mapping element-local time to source
 * offset in SECONDS (values), stored at this property path with keyframe times
 * in element-local ticks. When present it takes precedence over the constant
 * `retime.rate`. Decreasing values produce reverse playback; bezier
 * interpolation gives smooth speed ramps.
 */
export const TIME_REMAP_PATH = "retime.sourceTime";

export function hasTimeRemap({
	animations,
}: {
	animations?: ElementAnimations;
}): boolean {
	const data = animations?.[TIME_REMAP_PATH];
	return getChannelsFromData({ data }).some((channel) => channel.keys.length > 0);
}

function getSafeRate({ rate }: { rate: number }): number {
	return clampRetimeRate({ rate });
}

/**
 * Tick-domain mapping (video/render paths). `clipTime` is element-local ticks;
 * returns the source offset in ticks.
 */
export function getSourceTimeAtClipTime({
	clipTime,
	retime,
	animations,
}: {
	clipTime: number;
	retime?: RetimeConfig;
	animations?: ElementAnimations;
}): number {
	const rate = getSafeRate({ rate: retime?.rate ?? 1 });
	if (hasTimeRemap({ animations })) {
		const sourceSeconds = resolveAnimationPathValueAtTime({
			animations: animations!,
			propertyPath: TIME_REMAP_PATH,
			localTime: clipTime,
			fallbackValue: (clipTime * rate) / TICKS_PER_SECOND,
		});
		return sourceSeconds * TICKS_PER_SECOND;
	}
	return clipTime * rate;
}

/**
 * Second-domain mapping (audio paths, which schedule in seconds).
 */
export function getSourceSecondsAtClipSeconds({
	clipSeconds,
	retime,
	animations,
}: {
	clipSeconds: number;
	retime?: RetimeConfig;
	animations?: ElementAnimations;
}): number {
	const rate = getSafeRate({ rate: retime?.rate ?? 1 });
	if (hasTimeRemap({ animations })) {
		return resolveAnimationPathValueAtTime({
			animations: animations!,
			propertyPath: TIME_REMAP_PATH,
			localTime: clipSeconds * TICKS_PER_SECOND,
			fallbackValue: clipSeconds * rate,
		});
	}
	return clipSeconds * rate;
}

export function getClipTimeAtSourceTime({
	sourceTime,
	retime,
}: {
	sourceTime: number;
	retime?: RetimeConfig;
}): number {
	return sourceTime / getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getEffectiveRateAt({
	retime,
}: {
	clipTime?: number;
	retime?: RetimeConfig;
}): number {
	return getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getTimelineDurationForSourceSpan({
	sourceSpan,
	retime,
}: {
	sourceSpan: number;
	retime?: RetimeConfig;
}): number {
	if (sourceSpan <= 0) {
		return 0;
	}
	return sourceSpan / getSafeRate({ rate: retime?.rate ?? 1 });
}

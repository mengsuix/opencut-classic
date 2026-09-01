import type { ElementAnimations, ScalarAnimationChannel } from "@/animation/types";
import { isLeafChannelData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime, TIME_REMAP_PATH } from "./resolve";

export function getSourceSpanAtClipTime({
	clipTime,
	retime,
	animations,
}: {
	clipTime: number;
	retime?: RetimeConfig;
	animations?: ElementAnimations;
}): number {
	return Math.max(0, getSourceTimeAtClipTime({ clipTime, retime, animations }));
}

/**
 * After splitting a remapped element, the right piece's trimStart advances by
 * the left piece's consumed source span. Remap values are source offsets
 * relative to trimStart, so the right channel shifts by the same amount to
 * keep pointing at the same source times.
 */
export function shiftTimeRemapChannelValues({
	animations,
	offsetSeconds,
}: {
	animations: ElementAnimations | undefined;
	offsetSeconds: number;
}): ElementAnimations | undefined {
	const data = animations?.[TIME_REMAP_PATH];
	if (!isLeafChannelData(data) || !isScalarChannel(data)) {
		return animations;
	}

	const shifted: ScalarAnimationChannel = {
		...data,
		keys: data.keys.map((key) => ({
			...key,
			// dv/dt handles are relative, so a constant value shift leaves them intact.
			value: Math.max(0, key.value + offsetSeconds),
		})),
	};
	return { ...animations, [TIME_REMAP_PATH]: shifted };
}

export function splitRetimeAtClipTime({
	retime,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
} {
	return { left: retime, right: retime };
}

export function adjustRetimeForTrimChange({
	retime,
}: {
	retime?: RetimeConfig;
	clipTrimTime: number;
	side: "start" | "end";
}): RetimeConfig | undefined {
	return retime;
}

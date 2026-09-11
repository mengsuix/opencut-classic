import { mediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";

export const DEFAULT_NEW_ELEMENT_DURATION = mediaTime({
	ticks: 5 * TICKS_PER_SECOND,
});

/**
 * Effect layers cover a stretch of timeline rather than a point edit, and they
 * are the element type most often added while zoomed out (long projects), where
 * a 5s block shrinks to a few pixels and reads as "nothing happened". Give them
 * a wider default so a fresh effect is visible at a glance.
 */
export const DEFAULT_EFFECT_DURATION = mediaTime({
	ticks: 30 * TICKS_PER_SECOND,
});

export function toElementDurationTicks({
	seconds,
}: {
	seconds: number | null | undefined;
}) {
	if (seconds == null) {
		return DEFAULT_NEW_ELEMENT_DURATION;
	}

	return mediaTimeFromSeconds({ seconds });
}

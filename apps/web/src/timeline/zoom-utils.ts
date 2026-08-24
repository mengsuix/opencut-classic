import {
	BASE_TIMELINE_PIXELS_PER_SECOND,
	MAX_TIMELINE_WIDTH_PX,
	TIMELINE_ZOOM_MAX,
} from "@/timeline/scale";
import { TICKS_PER_SECOND } from "@/wasm";

const PADDING_MAX_RATIO = 0.75;
const PADDING_MIN_RATIO = 0.15;
const PADDING_MIN_AT_ZOOM_PERCENT = 0.2;

/**
 * Largest zoom that keeps the timeline's DOM width under
 * `MAX_TIMELINE_WIDTH_PX`. Longer media gets less magnification — that is the
 * deliberate tradeoff that keeps scroll/scrub cost duration-independent.
 */
export function getTimelineZoomMax({ duration }: { duration: number }): number {
	const durationSeconds = duration / TICKS_PER_SECOND;
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return TIMELINE_ZOOM_MAX;
	}

	const zoomAtMaxWidth =
		MAX_TIMELINE_WIDTH_PX /
		(durationSeconds * BASE_TIMELINE_PIXELS_PER_SECOND);

	// Never clamp below 1x, otherwise absurdly long media would be unusable.
	return Math.max(1, Math.min(TIMELINE_ZOOM_MAX, zoomAtMaxWidth));
}

export function getTimelineZoomMin({
	duration,
	containerWidth,
}: {
	duration: number;
	containerWidth: number | null | undefined;
}): number {
	const safeDurationSeconds = Math.max(duration / TICKS_PER_SECOND, 1);
	const safeContainerWidth = containerWidth ?? 1000;
	const contentRatioAtMinZoom = 1 - PADDING_MAX_RATIO;
	const availableWidth = safeContainerWidth * contentRatioAtMinZoom;
	const zoomToFit =
		availableWidth / (safeDurationSeconds * BASE_TIMELINE_PIXELS_PER_SECOND);

	return Math.min(TIMELINE_ZOOM_MAX, zoomToFit);
}

export function getTimelinePaddingPx({
	containerWidth,
	zoomLevel,
	minZoom,
	maxZoom = TIMELINE_ZOOM_MAX,
}: {
	containerWidth: number;
	zoomLevel: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	const zoomPercent = getZoomPercent({ zoomLevel, minZoom, maxZoom });
	const paddingTransitionPercent = Math.min(
		zoomPercent / PADDING_MIN_AT_ZOOM_PERCENT,
		1,
	);
	const paddingRatio =
		PADDING_MAX_RATIO -
		(PADDING_MAX_RATIO - PADDING_MIN_RATIO) * paddingTransitionPercent;

	return containerWidth * paddingRatio;
}

export function getZoomPercent({
	zoomLevel,
	minZoom,
	maxZoom = TIMELINE_ZOOM_MAX,
}: {
	zoomLevel: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	const span = maxZoom - minZoom;
	if (span <= 0) return 0;
	return (zoomLevel - minZoom) / span;
}

/**
 * convert linear slider position (0-1) to exponential zoom level.
 * at low slider values, zoom changes are small. at high values, changes are large.
 */
export function sliderToZoom({
	sliderPosition,
	minZoom,
	maxZoom = TIMELINE_ZOOM_MAX,
}: {
	sliderPosition: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	const clampedPosition = Math.max(0, Math.min(1, sliderPosition));
	return minZoom * (maxZoom / minZoom) ** clampedPosition;
}

/**
 * convert exponential zoom level to linear slider position (0-1).
 */
export function zoomToSlider({
	zoomLevel,
	minZoom,
	maxZoom = TIMELINE_ZOOM_MAX,
}: {
	zoomLevel: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	const clampedZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel));
	return Math.log(clampedZoom / minZoom) / Math.log(maxZoom / minZoom);
}

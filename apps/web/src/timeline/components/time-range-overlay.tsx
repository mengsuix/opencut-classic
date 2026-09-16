"use client";

import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { TIMELINE_LAYERS } from "./layers";

/**
 * Full-height highlights for the user's time-range marks (drag in the ruler
 * or tracks while in range-marking mode).
 *
 * Rendered inside the scrollable tracks content: the horizontal position is
 * plain content coordinates, so native scrolling keeps it pixel-aligned with
 * the ruler band. Deriving it from the shared viewport store instead would
 * lag behind — that store is quantized (256px buckets) for windowed
 * rendering, which visibly split the highlight from the ruler band.
 */
export function TimeRangeOverlay({ zoomLevel }: { zoomLevel: number }) {
	const timeRanges = useUserMarksStore((s) => s.timeRanges);
	const draftTimeRange = useUserMarksStore((s) => s.draftTimeRange);

	if (timeRanges.length === 0 && !draftTimeRange) {
		return null;
	}

	const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
	const bands = [
		...timeRanges.map((range) => ({ key: String(range.id), ...range })),
		...(draftTimeRange ? [{ key: "draft", ...draftTimeRange }] : []),
	];

	return (
		<>
			{bands.map((band) => (
				<div
					key={band.key}
					className="border-primary/40 bg-primary/10 pointer-events-none absolute inset-y-0 border-x"
					style={{
						left: `${band.startTime * pixelsPerSecond}px`,
						width: `${(band.endTime - band.startTime) * pixelsPerSecond}px`,
						zIndex: TIMELINE_LAYERS.userRange,
					}}
				/>
			))}
		</>
	);
}

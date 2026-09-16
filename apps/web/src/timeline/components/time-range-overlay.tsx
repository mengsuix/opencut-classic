"use client";

import { useContainerSize } from "@/hooks/use-container-size";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { useQuantizedTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { TIMELINE_LAYERS } from "./layers";

/**
 * Full-height highlight for the user's time-range mark (Alt+drag on the
 * ruler, or I/O keys at the playhead). Positioned against the scroll
 * viewport like the playhead; pointer-transparent.
 */
export function TimeRangeOverlay({
	zoomLevel,
	timelineRef,
}: {
	zoomLevel: number;
	timelineRef: React.RefObject<HTMLDivElement | null>;
}) {
	const timeRange = useUserMarksStore((s) => s.timeRange);
	const draftTimeRange = useUserMarksStore((s) => s.draftTimeRange);
	const { scrollLeft, viewportWidth } = useQuantizedTimelineViewport();
	const { height } = useContainerSize({ containerRef: timelineRef });

	const displayedRange = draftTimeRange ?? timeRange;
	if (!displayedRange || height <= 0) {
		return null;
	}

	const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
	const left = Math.max(0, displayedRange.startTime * pixelsPerSecond - scrollLeft);
	const right = Math.min(
		viewportWidth,
		displayedRange.endTime * pixelsPerSecond - scrollLeft,
	);
	if (right - left <= 0) {
		return null;
	}

	return (
		<div
			className="border-primary/40 bg-primary/10 pointer-events-none absolute border-x"
			style={{
				left: `${left}px`,
				top: 0,
				width: `${right - left}px`,
				height: `${height}px`,
				zIndex: TIMELINE_LAYERS.userRange,
			}}
		/>
	);
}

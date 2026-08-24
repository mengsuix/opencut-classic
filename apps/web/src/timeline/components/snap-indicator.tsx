"use client";

import { useCallback, useRef } from "react";
import { useContainerSize } from "@/hooks/use-container-size";
import {
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX } from "./layout";
import type { SnapPoint } from "@/timeline/snapping";
import { useRawTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";
import { TIMELINE_LAYERS } from "./layers";

interface SnapIndicatorProps {
	snapPoint: SnapPoint | null;
	zoomLevel: number;
	isVisible: boolean;
	timelineRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Positioned imperatively from the shared viewport store: it is only visible
 * during a drag, and reading scroll offset through React state would re-render
 * the timeline on every scroll frame.
 */
export function SnapIndicator({
	snapPoint,
	zoomLevel,
	isVisible,
	timelineRef,
}: SnapIndicatorProps) {
	const indicatorRef = useRef<HTMLDivElement>(null);
	const { height: timelineHeight } = useContainerSize({
		containerRef: timelineRef,
	});
	const height = (timelineHeight || 400) - 8;

	const snapTime = snapPoint?.time ?? null;

	const reposition = useCallback(
		({ scrollLeft }: { scrollLeft: number }) => {
			const element = indicatorRef.current;
			if (!element || snapTime === null) return;

			const centerPixel =
				TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX +
				timelineTimeToSnappedPixels({ time: snapTime, zoomLevel }) -
				scrollLeft;
			element.style.left = `${getCenteredLineLeft({ centerPixel })}px`;
		},
		[snapTime, zoomLevel],
	);

	useRawTimelineViewport(reposition);

	if (!isVisible || snapTime === null) {
		return null;
	}

	return (
		<div
			ref={indicatorRef}
			className="pointer-events-none absolute"
			style={{
				top: 0,
				height: `${height}px`,
				width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
				zIndex: TIMELINE_LAYERS.snapIndicator,
			}}
		>
			<div className={"bg-primary/40 h-full w-0.5 opacity-80"} />
		</div>
	);
}

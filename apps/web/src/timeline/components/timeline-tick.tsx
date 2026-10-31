"use client";

import { memo } from "react";
import type { FrameRate } from "opencut-wasm";
import { timelineTimeToSnappedPixels } from "@/timeline";
import { formatRulerLabel } from "@/timeline/ruler-utils";

interface TimelineTickProps {
	time: number;
	timeInSeconds: number;
	zoomLevel: number;
	fps: FrameRate;
	showLabel: boolean;
}

// Memoized: scrolling across a viewport bucket re-renders the ruler, but most
// ticks in the new window are the same ones (keyed by index) with identical
// props — re-formatting ~140 labels per bucket was most of the ruler's cost.
export const TimelineTick = memo(function TimelineTick({
	time,
	timeInSeconds,
	zoomLevel,
	fps,
	showLabel,
}: TimelineTickProps) {
	const leftPosition = timelineTimeToSnappedPixels({ time, zoomLevel });

	if (showLabel) {
		const label = formatRulerLabel({ timeInSeconds, fps });
		return (
			<span
				className="text-muted-foreground/85 absolute top-1 select-none text-[10px] leading-none"
				style={{ left: `${leftPosition}px` }}
			>
				{label}
			</span>
		);
	}

	return (
		<div
			className="border-muted-foreground/25 absolute top-1.5 h-1.5 border-l"
			style={{ left: `${leftPosition}px` }}
		/>
	);
});

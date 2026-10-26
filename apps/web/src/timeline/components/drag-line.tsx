import { useRef } from "react";
import { getDropLineY } from "./drop-target";
import type { TimelineTrack, DropTarget } from "@/timeline";
import { getTrackHeight } from "./track-layout";
import {
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline/pixel-utils";
import { TIMELINE_LAYERS } from "./layers";
import { timelineViewport } from "@/timeline/viewport-store";
import { useRawTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";

interface DragLineProps {
	dropTarget: DropTarget | null;
	tracks: TimelineTrack[];
	isVisible: boolean;
	headerHeight?: number;
	zoomLevel?: number;
	/** Same-track element drags already show the element at the landing slot —
	 *  the ghost block would just dim it. */
	suppressGhost?: boolean;
}

export function DragLine({
	dropTarget,
	tracks,
	isVisible,
	headerHeight = 0,
	zoomLevel,
	suppressGhost = false,
}: DragLineProps) {
	// The line lives outside the tracks scroll container, so it must counter
	// the container's vertical scroll offset to stay glued to the drop target.
	const lineRef = useRef<HTMLDivElement | null>(null);
	const setLineRef = (element: HTMLDivElement | null) => {
		lineRef.current = element;
		if (element) {
			element.style.transform = `translateY(${-timelineViewport.cached.scrollTop}px)`;
		}
	};
	useRawTimelineViewport(({ scrollTop }) => {
		const line = lineRef.current;
		if (line) line.style.transform = `translateY(${-scrollTop}px)`;
	});

	if (!isVisible || !dropTarget) return null;

	const y = getDropLineY({ dropTarget, tracks });
	const lineTop = y + headerHeight;
	const targetTrack = tracks[Math.min(dropTarget.trackIndex, tracks.length - 1)];

	// Rejected drop: paint the hovered track row as a forbidden zone.
	if (dropTarget.isInvalid) {
		if (!targetTrack) return null;
		return (
			<div
				ref={setLineRef}
				className="border-destructive/70 bg-destructive/15 pointer-events-none absolute right-0 left-0 rounded-sm border"
				style={{
					top: `${lineTop}px`,
					height: `${getTrackHeight({ type: targetTrack.type })}px`,
					zIndex: TIMELINE_LAYERS.dragLine,
				}}
			/>
		);
	}

	// Existing-track drop with a known duration: ghost placeholder block at the
	// landing slot, plus the thin insert line for ripple inserts.
	if (!dropTarget.isNewTrack && !suppressGhost && dropTarget.elementDuration !== undefined && zoomLevel !== undefined) {
		if (!targetTrack) return null;
		const trackHeight = getTrackHeight({ type: targetTrack.type });
		const left = timelineTimeToSnappedPixels({
			time: dropTarget.xPosition,
			zoomLevel,
		});
		const width = timelineTimeToPixels({
			time: dropTarget.elementDuration,
			zoomLevel,
		});
		const centerPixel = left;

		return (
			<div
				ref={setLineRef}
				className="pointer-events-none absolute inset-x-0 top-0"
				style={{ zIndex: TIMELINE_LAYERS.dragLine }}
			>
				<div
					className="border-primary/60 bg-primary/20 absolute rounded-sm border"
					style={{
						top: `${lineTop}px`,
						left: `${left}px`,
						width: `${width}px`,
						height: `${trackHeight}px`,
					}}
				/>
				{dropTarget.insertRipple && (
					<div
						className="bg-primary absolute"
						style={{
							top: `${lineTop}px`,
							left: `${getCenteredLineLeft({ centerPixel })}px`,
							width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
							height: `${trackHeight}px`,
						}}
					/>
				)}
			</div>
		);
	}

	if (dropTarget.insertRipple && zoomLevel !== undefined) {
		if (!targetTrack) return null;

		const centerPixel = timelineTimeToSnappedPixels({
			time: dropTarget.xPosition,
			zoomLevel,
		});

		return (
			<div
				ref={setLineRef}
				className="bg-primary pointer-events-none absolute"
				style={{
					top: `${lineTop}px`,
					left: `${getCenteredLineLeft({ centerPixel })}px`,
					width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
					height: `${getTrackHeight({ type: targetTrack.type })}px`,
					zIndex: TIMELINE_LAYERS.dragLine,
				}}
			/>
		);
	}

	return (
		<div
			ref={setLineRef}
			className="bg-primary pointer-events-none absolute right-0 left-0 h-0.5"
			style={{ top: `${lineTop}px`, zIndex: TIMELINE_LAYERS.dragLine }}
		/>
	);
}

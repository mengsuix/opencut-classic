"use client";

import {
	createContext,
	memo,
	useCallback,
	useContext,
	useDeferredValue,
	useMemo,
} from "react";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ElementDragView } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { useQuantizedTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";
import { useT } from "@/i18n";

/**
 * Elements this far outside the viewport are still mounted, so a fast scroll
 * doesn't reveal empty space before the next quantized update lands.
 */
const TRACK_ELEMENT_OVERSCAN_PX = 1024;

/**
 * The timeline's *live* zoom level. Track rows receive a deferred zoom through
 * props (clips are re-laid out in a background render); this context lets each
 * track window and stretch its clip layer against the live zoom without
 * re-rendering the rows/menus in between on every zoom step.
 */
export const TimelineLiveZoomContext = createContext<number | null>(null);

interface TimelineTrackContentProps {
	track: TimelineTrack;
	/** Position in the rendered track list, used to disambiguate same-named
	 *  tracks in the aria label. */
	index: number;
	/** Zoom the clips are laid out at (may lag the live zoom mid-gesture). */
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
}

export const TimelineTrackContent = memo(function TimelineTrackContent({
	track,
	index,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
}: TimelineTrackContentProps) {
	const t = useT();
	const { isElementSelected } = useElementSelection();
	const liveZoomLevel = useContext(TimelineLiveZoomContext) ?? zoomLevel;
	const layoutScale = liveZoomLevel / zoomLevel;
	const quantizedViewport = useQuantizedTimelineViewport();
	// Clips entering the window land in the overscan band first (overscan
	// 1024px > a playback page-flip of half a viewport), so mounting them can
	// run as an interruptible background render instead of blocking the frame
	// that crossed the bucket. Mid-zoom the window must track the live scroll
	// synchronously, otherwise the scroll compensation can outrun the overscan.
	const deferredViewport = useDeferredValue(quantizedViewport);
	const { scrollLeft, viewportWidth } =
		liveZoomLevel === zoomLevel ? deferredViewport : quantizedViewport;

	// Only mount elements that intersect the visible window. Keeps DOM size a
	// function of viewport width instead of clip count. Windowing uses the live
	// zoom because the scroll position already reflects it.
	const visibleElements = useMemo(() => {
		if (viewportWidth <= 0) return track.elements;

		const windowLeft = scrollLeft - TRACK_ELEMENT_OVERSCAN_PX;
		const windowRight = scrollLeft + viewportWidth + TRACK_ELEMENT_OVERSCAN_PX;

		return track.elements.filter((element) => {
			const left = timelineTimeToPixels({
				time: element.startTime,
				zoomLevel: liveZoomLevel,
			});
			const right =
				left +
				timelineTimeToPixels({
					time: element.duration,
					zoomLevel: liveZoomLevel,
				});
			return right >= windowLeft && left <= windowRight;
		});
	}, [track.elements, liveZoomLevel, scrollLeft, viewportWidth]);

	// A dragged element must stay mounted even when its committed position is far
	// offscreen, since its rendered position follows the pointer.
	const renderedElements = useMemo(() => {
		if (dragView.kind !== "dragging") return visibleElements;

		const included = new Set(visibleElements.map((element) => element.id));
		const dragged = track.elements.filter(
			(element) =>
				dragView.memberTimeOffsets.has(element.id) && !included.has(element.id),
		);
		return dragged.length > 0 ? [...visibleElements, ...dragged] : visibleElements;
	}, [visibleElements, dragView, track.elements]);

	// Per-track adapters with stable identities, so memoized elements don't
	// re-render just because this track did.
	const handleResizeStart = useCallback(
		({
			event,
			element,
			side,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
			side: "left" | "right";
		}) => onResizeStart({ event, element, track, side }),
		[onResizeStart, track],
	);
	const handleElementMouseDown = useCallback(
		({
			event,
			element,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
		}) => onElementMouseDown({ event, element, track }),
		[onElementMouseDown, track],
	);
	const handleElementClick = useCallback(
		({
			event,
			element,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
		}) => onElementClick({ event, element, track }),
		[onElementClick, track],
	);

	return (
		<div
			className="relative size-full"
			// While stretched mid-zoom the layer is wider than the content and
			// would inflate the scroller's scrollWidth (and thus the zoom scroll
			// clamp). Clip only during the stretch so dragged clips stay visible.
			style={layoutScale !== 1 ? { overflowX: "clip" } : undefined}
		>
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={t("timeline.seekOnTrack", {
					index: index + 1,
					name: track.name,
				})}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{
					zIndex: TIMELINE_LAYERS.trackContent,
					transform:
						layoutScale !== 1 ? `scaleX(${layoutScale})` : undefined,
					transformOrigin: "0 0",
				}}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					renderedElements.map((element) => (
						<TimelineElement
							key={element.id}
							element={element}
							track={track}
							zoomLevel={zoomLevel}
							isSelected={isElementSelected({
								trackId: track.id,
								elementId: element.id,
							})}
							onResizeStart={handleResizeStart}
							onElementMouseDown={handleElementMouseDown}
							onElementClick={handleElementClick}
							dragView={dragView}
							isDropTarget={element.id === targetElementId}
						/>
					))
				)}
			</div>
		</div>
	);
});

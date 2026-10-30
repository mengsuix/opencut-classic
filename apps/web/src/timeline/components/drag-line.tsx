import { useRef } from "react";
import { formatTimecode } from "opencut-wasm";
import { getDropLineY } from "./drop-target";
import type { TimelineTrack, DropTarget } from "@/timeline";
import { getTrackHeight } from "./track-layout";
import { TIMELINE_TRACK_GAP_PX } from "./layout";
import {
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline/pixel-utils";
import { TIMELINE_LAYERS } from "./layers";
import { timelineViewport } from "@/timeline/viewport-store";
import { useRawTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";
import { useEditor } from "@/editor/use-editor";

interface DragLineProps {
	dropTarget: DropTarget | null;
	tracks: TimelineTrack[];
	isVisible: boolean;
	headerHeight?: number;
	zoomLevel?: number;
	/** Same-track element drags already show the element at the landing slot —
	 *  the ghost block would just dim it. */
	suppressGhost?: boolean;
	collapsedTrackIds?: ReadonlySet<string>;
	trackOffsets?: readonly number[];
	trackTotalHeight?: number;
}

export function DragLine({
	dropTarget,
	tracks,
	isVisible,
	headerHeight = 0,
	zoomLevel,
	suppressGhost = false,
	collapsedTrackIds,
	trackOffsets,
	trackTotalHeight,
}: DragLineProps) {
	const fps = useEditor((editor) => editor.project.getActive().settings.fps);
	// The line lives outside the tracks scroll container, so it must counter
	// the container's vertical scroll offset to stay glued to the drop target.
	const lineRef = useRef<HTMLDivElement | null>(null);
	const horizontalLineRef = useRef<HTMLDivElement | null>(null);
	const setLineRef = (element: HTMLDivElement | null) => {
		lineRef.current = element;
		if (element) {
			element.style.transform = `translateY(${-timelineViewport.cached.scrollTop}px)`;
		}
	};
	useRawTimelineViewport(({ scrollTop, scrollLeft }) => {
		const line = lineRef.current;
		if (line) line.style.transform = `translateY(${-scrollTop}px)`;
		if (horizontalLineRef.current) {
			horizontalLineRef.current.style.transform = `translateX(${-scrollLeft}px)`;
		}
	});

	if (!isVisible || !dropTarget) return null;

	const computedY = getDropLineY({ dropTarget, tracks, collapsedTrackIds });
	const y =
		trackOffsets?.[dropTarget.trackIndex] ??
		(dropTarget.trackIndex === tracks.length && trackTotalHeight !== undefined
			? trackTotalHeight + TIMELINE_TRACK_GAP_PX
			: computedY);
	const lineTop = y + headerHeight;
	const targetTrack =
		tracks[Math.min(dropTarget.trackIndex, tracks.length - 1)];
	const targetTrackHeight = targetTrack
		? getTrackHeight({
				type: targetTrack.type,
				collapsed: collapsedTrackIds?.has(targetTrack.id),
			})
		: 0;

	// Rejected drop: paint the hovered track row as a forbidden zone.
	if (dropTarget.isInvalid) {
		if (!targetTrack) return null;
		return (
			<div
				ref={setLineRef}
				className="border-destructive/70 bg-destructive/15 pointer-events-none absolute right-0 left-0 rounded-sm border"
				style={{
					top: `${lineTop}px`,
					height: `${targetTrackHeight}px`,
					zIndex: TIMELINE_LAYERS.dragLine,
				}}
			/>
		);
	}

	if (
		suppressGhost &&
		!dropTarget.isNewTrack &&
		targetTrack &&
		zoomLevel !== undefined
	) {
		const centerPixel = timelineTimeToSnappedPixels({
			time: dropTarget.xPosition,
			zoomLevel,
		});
		const start = formatTimecode({
			time: dropTarget.xPosition,
			format: "HH:MM:SS:FF",
			rate: fps,
		});
		const duration =
			dropTarget.elementDuration === undefined
				? null
				: formatTimecode({
						time: dropTarget.elementDuration,
						format: "HH:MM:SS:FF",
						rate: fps,
					});

		return (
			<div
				ref={setLineRef}
				className="pointer-events-none absolute inset-0"
				style={{ zIndex: TIMELINE_LAYERS.dragLine }}
			>
				<div
					ref={(element) => {
						horizontalLineRef.current = element;
						if (element) {
							element.style.transform = `translateX(${-timelineViewport.cached.scrollLeft}px)`;
						}
					}}
					className="absolute top-0 left-0"
				>
					<div
						className="bg-primary absolute"
						style={{
							top: `${lineTop}px`,
							left: `${getCenteredLineLeft({ centerPixel })}px`,
							width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
							height: `${targetTrackHeight}px`,
						}}
					/>
					<div
						className="bg-popover text-popover-foreground absolute rounded-sm border px-2 py-1 font-mono text-[10px] whitespace-nowrap shadow-md"
						style={{
							top: `${Math.max(headerHeight, lineTop - 28)}px`,
							left: `${centerPixel + 6}px`,
						}}
					>
						{start}
						{duration ? ` / ${duration}` : ""}
					</div>
				</div>
			</div>
		);
	}

	// Existing-track drop with a known duration: ghost placeholder block at the
	// landing slot, plus the thin insert line for ripple inserts.
	if (
		!dropTarget.isNewTrack &&
		!suppressGhost &&
		dropTarget.elementDuration !== undefined &&
		zoomLevel !== undefined
	) {
		if (!targetTrack) return null;
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
						height: `${targetTrackHeight}px`,
					}}
				/>
				{dropTarget.insertRipple && (
					<div
						className="bg-primary absolute"
						style={{
							top: `${lineTop}px`,
							left: `${getCenteredLineLeft({ centerPixel })}px`,
							width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
							height: `${targetTrackHeight}px`,
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
					height: `${targetTrackHeight}px`,
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

import { getDropLineY } from "./drop-target";
import type { TimelineTrack, DropTarget } from "@/timeline";
import { getTrackHeight } from "./track-layout";
import {
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
	timelineTimeToSnappedPixels,
} from "@/timeline/pixel-utils";
import { TIMELINE_LAYERS } from "./layers";

interface DragLineProps {
	dropTarget: DropTarget | null;
	tracks: TimelineTrack[];
	isVisible: boolean;
	headerHeight?: number;
	zoomLevel?: number;
}

export function DragLine({
	dropTarget,
	tracks,
	isVisible,
	headerHeight = 0,
	zoomLevel,
}: DragLineProps) {
	if (!isVisible || !dropTarget) return null;

	const y = getDropLineY({ dropTarget, tracks });
	const lineTop = y + headerHeight;

	if (dropTarget.insertRipple && zoomLevel !== undefined) {
		const track = tracks[Math.min(dropTarget.trackIndex, tracks.length - 1)];
		if (!track) return null;

		const centerPixel = timelineTimeToSnappedPixels({
			time: dropTarget.xPosition,
			zoomLevel,
		});

		return (
			<div
				className="bg-primary pointer-events-none absolute"
				style={{
					top: `${lineTop}px`,
					left: `${getCenteredLineLeft({ centerPixel })}px`,
					width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
					height: `${getTrackHeight({ type: track.type })}px`,
					zIndex: TIMELINE_LAYERS.dragLine,
				}}
			/>
		);
	}

	return (
		<div
			className="bg-primary pointer-events-none absolute right-0 left-0 h-0.5"
			style={{ top: `${lineTop}px`, zIndex: TIMELINE_LAYERS.dragLine }}
		/>
	);
}

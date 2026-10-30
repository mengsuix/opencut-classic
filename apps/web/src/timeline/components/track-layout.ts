import type { TrackType } from "@/timeline";
import {
	KEYFRAME_LANE_HEIGHT_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_HEIGHTS_PX,
} from "./layout";

export function getTrackHeight({ type }: { type: TrackType }): number {
	return TIMELINE_TRACK_HEIGHTS_PX[type];
}

export function getExpandedTrackHeight({
	type,
	expandedLaneCount,
}: {
	type: TrackType;
	expandedLaneCount: number;
}): number {
	return (
		TIMELINE_TRACK_HEIGHTS_PX[type] +
		expandedLaneCount * KEYFRAME_LANE_HEIGHT_PX
	);
}

/**
 * Cumulative offsets for every track, plus the total height.
 *
 * Prefer this over calling `getCumulativeHeightBefore` per track: that walks the
 * preceding tracks each time, making a full render O(n²).
 */
export function getTrackOffsets({
	tracks,
	getExtraHeight,
}: {
	tracks: Array<{ type: TrackType }>;
	getExtraHeight?: (trackIndex: number) => number;
}): { offsets: number[]; totalHeight: number } {
	const offsets: number[] = new Array(tracks.length);
	let cursor = 0;

	for (let index = 0; index < tracks.length; index += 1) {
		offsets[index] = cursor;
		cursor +=
			getTrackHeight({ type: tracks[index].type }) +
			(getExtraHeight?.(index) ?? 0) +
			TIMELINE_TRACK_GAP_PX;
	}

	const totalHeight = Math.max(0, cursor - TIMELINE_TRACK_GAP_PX);
	return { offsets, totalHeight };
}

export function getCumulativeHeightBefore({
	tracks,
	trackIndex,
	getExtraHeight,
}: {
	tracks: Array<{ type: TrackType }>;
	trackIndex: number;
	getExtraHeight?: (trackIndex: number) => number;
}): number {
	return tracks
		.slice(0, trackIndex)
		.reduce(
			(sum, track, i) =>
				sum +
				getTrackHeight({ type: track.type }) +
				(getExtraHeight?.(i) ?? 0) +
				TIMELINE_TRACK_GAP_PX,
			0,
		);
}

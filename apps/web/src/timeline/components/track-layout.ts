import type { TrackType } from "@/timeline";
import {
	KEYFRAME_LANE_HEIGHT_PX,
	TIMELINE_COLLAPSED_TRACK_HEIGHT_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_HEIGHTS_PX,
} from "./layout";

function canCollapse(type: TrackType): boolean {
	return type === "text" || type === "graphic" || type === "effect";
}

export function getTrackHeight({
	type,
	collapsed = false,
}: {
	type: TrackType;
	collapsed?: boolean;
}): number {
	return collapsed && canCollapse(type)
		? TIMELINE_COLLAPSED_TRACK_HEIGHT_PX
		: TIMELINE_TRACK_HEIGHTS_PX[type];
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
	collapsedTrackIds,
}: {
	tracks: Array<{ id: string; type: TrackType }>;
	getExtraHeight?: (trackIndex: number) => number;
	collapsedTrackIds?: ReadonlySet<string>;
}): { offsets: number[]; totalHeight: number } {
	const offsets: number[] = new Array(tracks.length);
	let cursor = 0;

	for (let index = 0; index < tracks.length; index += 1) {
		const track = tracks[index];
		const collapsed =
			canCollapse(track.type) && (collapsedTrackIds?.has(track.id) ?? false);
		offsets[index] = cursor;
		cursor +=
			getTrackHeight({ type: track.type, collapsed }) +
			(collapsed ? 0 : (getExtraHeight?.(index) ?? 0)) +
			TIMELINE_TRACK_GAP_PX;
	}

	const totalHeight = Math.max(0, cursor - TIMELINE_TRACK_GAP_PX);
	return { offsets, totalHeight };
}

export function getCumulativeHeightBefore({
	tracks,
	trackIndex,
	getExtraHeight,
	collapsedTrackIds,
}: {
	tracks: Array<{ id: string; type: TrackType }>;
	trackIndex: number;
	getExtraHeight?: (trackIndex: number) => number;
	collapsedTrackIds?: ReadonlySet<string>;
}): number {
	return tracks.slice(0, trackIndex).reduce((sum, track, i) => {
		const collapsed =
			canCollapse(track.type) && (collapsedTrackIds?.has(track.id) ?? false);
		return (
			sum +
			getTrackHeight({ type: track.type, collapsed }) +
			(collapsed ? 0 : (getExtraHeight?.(i) ?? 0)) +
			TIMELINE_TRACK_GAP_PX
		);
	}, 0);
}

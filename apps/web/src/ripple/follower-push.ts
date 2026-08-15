import type { TimelineTrack } from "@/timeline/types";
import { addMediaTime, type MediaTime, subMediaTime } from "@/wasm";

export interface FollowerPushPlan {
	/** Start of the earliest overlapped follower — shift boundary. */
	afterTime: MediaTime;
	/** How far the follower chain moves right (resolves the overlap exactly). */
	shiftAmount: MediaTime;
}

/**
 * Plans a follower push for a same-track rightward move (magnetic-style
 * drag): when the moved element would overlap its right neighbors, the whole
 * chain starting at the earliest overlapped follower shifts right so the
 * original spacing is preserved. Elements after the chain keep their offsets
 * because the shift applies to everything at/after `afterTime`.
 *
 * Returns null when the move is not rightward or nothing overlaps — in that
 * case the caller falls back to a plain move.
 */
export function planFollowerPush({
	track,
	anchorElementId,
	anchorNewStartTime,
	anchorOriginalStartTime,
	anchorDuration,
}: {
	track: TimelineTrack;
	anchorElementId: string;
	anchorNewStartTime: MediaTime;
	anchorOriginalStartTime: MediaTime;
	anchorDuration: MediaTime;
}): FollowerPushPlan | null {
	if (anchorNewStartTime <= anchorOriginalStartTime) {
		return null;
	}

	const anchorEnd = addMediaTime({
		a: anchorNewStartTime,
		b: anchorDuration,
	});
	const overlappingFollowers = track.elements.filter(
		(element) =>
			element.id !== anchorElementId &&
			element.startTime < anchorEnd &&
			addMediaTime({ a: element.startTime, b: element.duration }) >
				anchorNewStartTime,
	);
	if (overlappingFollowers.length === 0) {
		return null;
	}

	const earliestOverlapStart = overlappingFollowers.reduce(
		(earliest, element) =>
			element.startTime < earliest ? element.startTime : earliest,
		overlappingFollowers[0].startTime,
	);
	const shiftAmount = subMediaTime({
		a: anchorEnd,
		b: earliestOverlapStart,
	});
	if (shiftAmount <= 0) {
		return null;
	}

	return { afterTime: earliestOverlapStart, shiftAmount };
}

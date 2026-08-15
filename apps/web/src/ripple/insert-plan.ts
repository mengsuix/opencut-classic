import type { TimelineTrack } from "@/timeline/types";
import { addMediaTime, type MediaTime } from "@/wasm";

export interface RippleInsertPlan {
	/** Final insert point after edge snapping. */
	insertTime: MediaTime;
	/** Element that strictly contains insertTime and must be split there. */
	splitElementId: string | null;
	/** How far elements at/after insertTime move right (the inserted duration). */
	shiftAmount: MediaTime;
}

/**
 * Plans a ripple insert on an existing track: split the element under the
 * insert point (if any), push everything at/after the insert point right by
 * the inserted duration, then place the new element at the insert point.
 *
 * Only meaningful when the desired span overlaps the track — callers decide
 * that before invoking this. Returns null for degenerate inputs.
 */
export function planRippleInsert({
	track,
	requestedInsertTime,
	elementDuration,
	snapTolerance = 0,
}: {
	track: TimelineTrack;
	requestedInsertTime: MediaTime;
	elementDuration: MediaTime;
	snapTolerance?: number;
}): RippleInsertPlan | null {
	if (elementDuration <= 0 || requestedInsertTime < 0) {
		return null;
	}

	const insertTime = snapInsertTimeToElementEdge({
		track,
		insertTime: requestedInsertTime,
		snapTolerance,
	});

	const containingElement = track.elements.find(
		(element) =>
			element.startTime < insertTime &&
			insertTime <
				addMediaTime({ a: element.startTime, b: element.duration }),
	);
	const hasShiftTargets = track.elements.some(
		(element) => element.startTime >= insertTime,
	);

	if (!containingElement && !hasShiftTargets) {
		return null;
	}

	return {
		insertTime,
		splitElementId: containingElement?.id ?? null,
		shiftAmount: elementDuration,
	};
}

/**
 * Snaps the insert point to the nearest element edge within tolerance so
 * dropping "at" a seam inserts exactly at the seam instead of creating a
 * micro-split a few frames off the boundary.
 */
function snapInsertTimeToElementEdge({
	track,
	insertTime,
	snapTolerance,
}: {
	track: TimelineTrack;
	insertTime: MediaTime;
	snapTolerance: number;
}): MediaTime {
	if (snapTolerance <= 0) {
		return insertTime;
	}

	let bestEdge: MediaTime | null = null;
	let bestDistance = Infinity;

	for (const element of track.elements) {
		const elementEnd = addMediaTime({
			a: element.startTime,
			b: element.duration,
		});
		for (const edge of [element.startTime, elementEnd]) {
			const distance = Math.abs(edge - insertTime);
			if (distance <= snapTolerance && distance < bestDistance) {
				bestEdge = edge;
				bestDistance = distance;
			}
		}
	}

	return bestEdge ?? insertTime;
}

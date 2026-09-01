import type { TimelineElement } from "@/timeline";
import type { PlacementTimeSpan } from "./types";

interface TrackWithElements {
	elements: TimelineElement[];
}

function wouldElementOverlap({
	elements,
	startTime,
	endTime,
	excludeElementId,
}: {
	elements: TimelineElement[];
	startTime: number;
	endTime: number;
	excludeElementId?: string;
}): boolean {
	return elements.some((element) => {
		if (excludeElementId && element.id === excludeElementId) {
			return false;
		}

		const elementEnd = element.startTime + element.duration;
		return startTime < elementEnd && endTime > element.startTime;
	});
}

function wouldTimeSpansOverlap({
	left,
	right,
}: {
	left: PlacementTimeSpan;
	right: PlacementTimeSpan;
}): boolean {
	return (
		left.startTime < right.startTime + right.duration &&
		left.startTime + left.duration > right.startTime
	);
}

function haveOverlappingTimeSpans(timeSpans: PlacementTimeSpan[]): boolean {
	for (let leftIndex = 0; leftIndex < timeSpans.length; leftIndex += 1) {
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < timeSpans.length;
			rightIndex += 1
		) {
			if (
				wouldTimeSpansOverlap({
					left: timeSpans[leftIndex],
					right: timeSpans[rightIndex],
				})
			) {
				return true;
			}
		}
	}

	return false;
}

export function canPlaceTimeSpansOnTrack({
	track,
	timeSpans,
}: {
	track: TrackWithElements;
	timeSpans: PlacementTimeSpan[];
}): boolean {
	if (haveOverlappingTimeSpans(timeSpans)) {
		return false;
	}

	return timeSpans.every(({ startTime, duration, excludeElementId }) => {
		return !wouldElementOverlap({
			elements: track.elements,
			startTime,
			endTime: startTime + duration,
			excludeElementId,
		});
	});
}

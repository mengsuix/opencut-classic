import type { TimelineTrack, TimelineElement } from "@/timeline";
import type { ComputeDropTargetParams, DropTarget } from "@/timeline";
import { VISUAL_ELEMENT_TYPES } from "@/timeline";
import {
	canElementGoOnTrack,
	resolveTrackPlacement,
} from "@/timeline/placement";
import { TIMELINE_TRACK_GAP_PX } from "./layout";
import { getTrackHeight } from "./track-layout";
import {
	addMediaTime,
	mediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";

function findElementAtPosition({
	mouseX,
	tracks,
	trackIndex,
	targetElementTypes,
	pixelsPerSecond,
	zoomLevel,
}: {
	mouseX: number;
	tracks: TimelineTrack[];
	trackIndex: number;
	targetElementTypes: string[];
	pixelsPerSecond: number;
	zoomLevel: number;
}): { elementId: string; trackId: string } | null {
	const time = mediaTime({
		ticks: Math.round(
			(mouseX / (pixelsPerSecond * zoomLevel)) * TICKS_PER_SECOND,
		),
	});
	const track = tracks[trackIndex];
	if (!track || !("elements" in track)) return null;

	const hit = track.elements.find(
		(element: TimelineElement) =>
			targetElementTypes.includes(element.type) &&
			element.startTime <= time &&
			time < element.startTime + element.duration,
	);
	if (!hit) return null;
	return { elementId: hit.id, trackId: track.id };
}

function getTrackAtY({
	mouseY,
	tracks,
	verticalDragDirection,
	collapsedTrackIds,
	trackLayout,
}: {
	mouseY: number;
	tracks: TimelineTrack[];
	verticalDragDirection?: "up" | "down" | null;
	collapsedTrackIds?: ReadonlySet<string>;
	trackLayout?: { offsets: readonly number[]; totalHeight: number };
}): { trackIndex: number; relativeY: number } | null {
	let cumulativeHeight = 0;

	for (let i = 0; i < tracks.length; i++) {
		const trackTop = trackLayout?.offsets[i] ?? cumulativeHeight;
		const nextTrackOffset = trackLayout?.offsets[i + 1];
		const layoutBottom =
			nextTrackOffset ??
			(i === tracks.length - 1 && trackLayout
				? trackLayout.totalHeight
				: undefined);
		const trackHeight =
			layoutBottom !== undefined
				? layoutBottom - trackTop - (nextTrackOffset !== undefined ? TIMELINE_TRACK_GAP_PX : 0)
				: getTrackHeight({
						type: tracks[i].type,
						collapsed: collapsedTrackIds?.has(tracks[i].id),
					});
		const trackBottom = trackTop + trackHeight;

		if (mouseY >= trackTop && mouseY < trackBottom) {
			return {
				trackIndex: i,
				relativeY: mouseY - trackTop,
			};
		}

		if (i < tracks.length - 1 && verticalDragDirection) {
			const gapTop = trackBottom;
			const gapBottom = gapTop + TIMELINE_TRACK_GAP_PX;
			if (mouseY >= gapTop && mouseY < gapBottom) {
				const isDraggingUp = verticalDragDirection === "up";
				return {
					trackIndex: isDraggingUp ? i : i + 1,
					relativeY: isDraggingUp ? trackHeight - 1 : 0,
				};
			}
		}

		cumulativeHeight += trackHeight + TIMELINE_TRACK_GAP_PX;
	}

	return null;
}

const EMPTY_TARGET_ELEMENT = null;

function fallbackNewTrackDropTarget({
	xPosition,
}: {
	xPosition: MediaTime;
}): DropTarget {
	return {
		trackIndex: 0,
		isNewTrack: true,
		insertPosition: null,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

export function computeDropTarget({
	elementType,
	mouseX,
	mouseY,
	tracks,
	playheadTime,
	isExternalDrop,
	elementDuration,
	pixelsPerSecond,
	zoomLevel,
	verticalDragDirection,
	startTimeOverride,
	excludeElementId,
	targetElementTypes,
	rippleInsertEnabled,
	allowOverlapClamp,
	collapsedTrackIds,
	trackLayout,
}: ComputeDropTargetParams): DropTarget {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mainTrackIndex = tracks.overlay.length;
	const xPosition =
		startTimeOverride !== undefined
			? startTimeOverride
			: isExternalDrop
				? playheadTime
				: mediaTime({
						ticks: Math.round(
							Math.max(0, mouseX / (pixelsPerSecond * zoomLevel)) *
								TICKS_PER_SECOND,
						),
					});

	if (orderedTracks.length === 0) {
		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: 0,
				hoverDirection: "below",
				createNewTrackOnly: true,
			},
		});
		const emptyTimelineResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!emptyTimelineResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: emptyTimelineResult.insertIndex,
			isNewTrack: true,
			insertPosition: emptyTimelineResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const trackAtMouse = getTrackAtY({
		mouseY,
		tracks: orderedTracks,
		verticalDragDirection,
		collapsedTrackIds,
		trackLayout,
	});

	if (!trackAtMouse) {
		const isAboveAllTracks = mouseY < 0;

		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: isAboveAllTracks ? 0 : orderedTracks.length - 1,
				hoverDirection: isAboveAllTracks ? "above" : "below",
				createNewTrackOnly: true,
			},
		});
		const outOfBoundsResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!outOfBoundsResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: outOfBoundsResult.insertIndex,
			isNewTrack: true,
			insertPosition: outOfBoundsResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const { trackIndex, relativeY } = trackAtMouse;
	const track = orderedTracks[trackIndex];

	// Dragging an effect element over a visual element means "attach this
	// effect to that clip" — same hit rule as dropping an effect card from
	// the assets panel, even though the drag started inside the timeline.
	const effectiveTargetElementTypes =
		targetElementTypes ??
		(elementType === "effect" ? VISUAL_ELEMENT_TYPES : undefined);
	if (effectiveTargetElementTypes && effectiveTargetElementTypes.length > 0) {
		const targetElement = findElementAtPosition({
			mouseX,
			tracks: orderedTracks,
			trackIndex,
			targetElementTypes: effectiveTargetElementTypes,
			pixelsPerSecond,
			zoomLevel,
		});
		// Replace-on-drop targets an existing element; ripple insert takes
		// precedence on compatible tracks (replace media is not implemented
		// yet, and dropping on an occupied span should insert instead of
		// being swallowed).
		const shouldRippleInsteadOfReplace =
			rippleInsertEnabled &&
			canElementGoOnTrack({ elementType, trackType: track.type });
		if (targetElement && !shouldRippleInsteadOfReplace) {
			return {
				trackIndex,
				isNewTrack: false,
				insertPosition: null,
				xPosition,
				targetElement,
			};
		}
	}

	const trackHeight = getTrackHeight({
		type: track.type,
		collapsed: collapsedTrackIds?.has(track.id),
	});

	// Hovering an existing track that cannot accept this element (wrong type
	// or locked) rejects the drop outright instead of silently overflowing
	// to a new track. New tracks are only created from empty areas.
	if (
		!canElementGoOnTrack({ elementType, trackType: track.type }) ||
		track.locked
	) {
		return {
			trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
			isInvalid: true,
			invalidReason: track.locked ? "locked" : "incompatible",
		};
	}

	const placementResult = resolveTrackPlacement({
		tracks,
		elementType,
		timeSpans: [
			{ startTime: xPosition, duration: elementDuration, excludeElementId },
		],
		strategy: {
			type: "preferIndex",
			trackIndex,
			hoverDirection: relativeY < trackHeight / 2 ? "above" : "below",
			verticalDragDirection,
		},
	});
	if (!placementResult) {
		return fallbackNewTrackDropTarget({ xPosition });
	}

	// Ripple insert: the span overlaps elements on this compatible track, so
	// instead of overflowing to a new track, insert at the drop point and
	// push the right side of the track along the timeline.
	if (
		rippleInsertEnabled &&
		placementResult.kind === "newTrack" &&
		canElementGoOnTrack({ elementType, trackType: track.type })
	) {
		return {
			trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
			insertRipple: true,
			elementDuration,
		};
	}

	// Overlap on a compatible track: clamp the drop to the nearest free slot
	// so it snaps against the neighbor's edge instead of silently overflowing
	// to a new track.
	if (
		allowOverlapClamp &&
		placementResult.kind === "newTrack" &&
		canElementGoOnTrack({ elementType, trackType: track.type })
	) {
		const clampedStart = findNearestFreeStartTime({
			track,
			duration: elementDuration,
			desiredStart: xPosition,
			excludeElementId,
		});
		if (clampedStart !== null) {
			return {
				trackIndex,
				isNewTrack: false,
				insertPosition: null,
				xPosition: clampedStart,
				targetElement: EMPTY_TARGET_ELEMENT,
				elementDuration,
			};
		}
	}

	if (placementResult.kind === "existingTrack") {
		const adjustedXPosition =
			placementResult.adjustedStartTime !== undefined
				? roundMediaTime({ time: placementResult.adjustedStartTime })
				: xPosition;

		return {
			trackIndex: placementResult.trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition: adjustedXPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
			elementDuration,
		};
	}

	return {
		trackIndex: placementResult.insertIndex,
		isNewTrack: true,
		insertPosition: placementResult.insertPosition,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

function findNearestFreeStartTime({
	track,
	duration,
	desiredStart,
	excludeElementId,
}: {
	track: TimelineTrack;
	duration: MediaTime;
	desiredStart: MediaTime;
	excludeElementId?: string;
}): MediaTime | null {
	const others = track.elements.filter(
		(element) => element.id !== excludeElementId,
	);

	const fits = (start: MediaTime): boolean =>
		start >= 0 &&
		!others.some(
			(element) =>
				start < element.startTime + element.duration &&
				start + duration > element.startTime,
		);

	if (fits(desiredStart)) return desiredStart;

	let best: MediaTime | null = null;
	for (const element of others) {
		const candidates: MediaTime[] = [
			subMediaTime({ a: element.startTime, b: duration }),
			addMediaTime({ a: element.startTime, b: element.duration }),
		];
		for (const candidate of candidates) {
			if (!fits(candidate)) continue;
			if (
				best === null ||
				Math.abs(candidate - desiredStart) < Math.abs(best - desiredStart)
			) {
				best = candidate;
			}
		}
	}
	return best;
}

export function getDropLineY({
	dropTarget,
	tracks,
	collapsedTrackIds,
}: {
	dropTarget: DropTarget;
	tracks: TimelineTrack[];
	collapsedTrackIds?: ReadonlySet<string>;
}): number {
	const safeTrackIndex = Math.min(
		Math.max(dropTarget.trackIndex, 0),
		tracks.length,
	);
	let y = 0;

	for (let i = 0; i < safeTrackIndex; i++) {
		y +=
			getTrackHeight({
				type: tracks[i].type,
				collapsed: collapsedTrackIds?.has(tracks[i].id),
			}) + TIMELINE_TRACK_GAP_PX;
	}

	return y;
}

import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import {
	addMediaTime,
	clampMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	minMediaTime,
	roundFrameTicks,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type {
	ComputeGroupResizeArgs,
	GroupResizeFollower,
	GroupResizeMember,
	GroupResizeResult,
	GroupResizeUpdate,
	ResizeSide,
} from "./types";

export function computeGroupResize({
	members,
	side,
	deltaTime,
	fps,
}: ComputeGroupResizeArgs): GroupResizeResult {
	if (members.length === 0) {
		return { deltaTime: ZERO_MEDIA_TIME, updates: [] };
	}

	const minDuration = mediaTime({
		ticks: Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator),
	});
	let minimumDeltaTime = getMinimumAllowedDeltaTime({
		member: members[0],
		side,
		minDuration,
	});
	let maximumDeltaTime = getMaximumAllowedDeltaTime({
		member: members[0],
		side,
		minDuration,
	});

	for (const member of members.slice(1)) {
		minimumDeltaTime = maxMediaTime({
			a: minimumDeltaTime,
			b: getMinimumAllowedDeltaTime({
				member,
				side,
				minDuration,
			}),
		});
		const memberMaximum = getMaximumAllowedDeltaTime({
			member,
			side,
			minDuration,
		});
		if (memberMaximum !== null) {
			maximumDeltaTime =
				maximumDeltaTime === null
					? memberMaximum
					: minMediaTime({ a: maximumDeltaTime, b: memberMaximum });
		}
	}

	const clampedDeltaTime =
		maximumDeltaTime === null
			? maxMediaTime({ a: minimumDeltaTime, b: deltaTime })
			: clampMediaTime({
					time: deltaTime,
					min: minimumDeltaTime,
					max: maximumDeltaTime,
				});

	// Snap the drag delta to a frame exactly once, then derive every patch
	// field from that single snapped value. This keeps the invariant
	// `trimStart + duration*rate + trimEnd == sourceDuration` exact: the same
	// delta is added on one side of the element and removed from the other,
	// so the rounding cancels by construction. Per-field rounding (the old
	// approach) couldn't preserve this because the individual rounds don't
	// compose when `sourceDuration` isn't frame-aligned.
	const snappedDeltaTime = mediaTime({
		ticks: roundFrameTicks({ ticks: clampedDeltaTime, fps }),
	});
	// Re-clamp after rounding. Bounds derived from other elements are
	// frame-aligned, so this is normally a no-op; at the source-extent limit
	// the bound may not be frame-aligned, and honouring the bound takes
	// precedence over frame alignment (you can't extend past real content).
	const finalDeltaTime =
		maximumDeltaTime === null
			? maxMediaTime({ a: minimumDeltaTime, b: snappedDeltaTime })
			: clampMediaTime({
					time: snappedDeltaTime,
					min: minimumDeltaTime,
					max: maximumDeltaTime,
				});

	const updates = members.map((member) =>
		buildResizeUpdate({
			member,
			side,
			deltaTime: finalDeltaTime,
		}),
	);
	if (side === "right") {
		updates.push(
			...buildRipplePushUpdates({ members, deltaTime: finalDeltaTime }),
		);
	}

	return {
		deltaTime: Object.is(finalDeltaTime, -0) ? ZERO_MEDIA_TIME : finalDeltaTime,
		updates,
	};
}

// Extending past the right neighbor ripples the track: every later element
// shifts right by the overflow instead of blocking the resize.
function buildRipplePushUpdates({
	members,
	deltaTime,
}: {
	members: GroupResizeMember[];
	deltaTime: MediaTime;
}): GroupResizeUpdate[] {
	const overflowByFollower = new Map<
		string,
		{ follower: GroupResizeFollower; overflow: MediaTime }
	>();

	for (const member of members) {
		if (member.rightNeighborBound === null) continue;
		const neighborCeiling = subMediaTime({
			a: member.rightNeighborBound,
			b: addMediaTime({ a: member.startTime, b: member.duration }),
		});
		if (deltaTime <= neighborCeiling) continue;
		const overflow = subMediaTime({ a: deltaTime, b: neighborCeiling });
		for (const follower of member.rightFollowers) {
			const key = `${follower.trackId}:${follower.elementId}`;
			const existing = overflowByFollower.get(key);
			if (!existing || overflow > existing.overflow) {
				overflowByFollower.set(key, { follower, overflow });
			}
		}
	}

	return [...overflowByFollower.values()].map(({ follower, overflow }) => ({
		trackId: follower.trackId,
		elementId: follower.elementId,
		patch: {
			startTime: addMediaTime({ a: follower.startTime, b: overflow }),
		},
	}));
}

function buildResizeUpdate({
	member,
	side,
	deltaTime,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	deltaTime: MediaTime;
}): GroupResizeUpdate {
	// Frozen elements never move their trims: both sides only change the
	// timeline span, the held frame stays at trimStart.
	if (member.freeze) {
		if (side === "left") {
			return {
				trackId: member.trackId,
				elementId: member.elementId,
				patch: {
					trimStart: member.trimStart,
					trimEnd: member.trimEnd,
					startTime: addMediaTime({ a: member.startTime, b: deltaTime }),
					duration: subMediaTime({ a: member.duration, b: deltaTime }),
				},
			};
		}
		return {
			trackId: member.trackId,
			elementId: member.elementId,
			patch: {
				trimStart: member.trimStart,
				trimEnd: member.trimEnd,
				startTime: member.startTime,
				duration: addMediaTime({ a: member.duration, b: deltaTime }),
			},
		};
	}

	const sourceDelta = getSourceDeltaForClipDelta({
		member,
		clipDelta: deltaTime,
	});

	if (side === "left") {
		return {
			trackId: member.trackId,
			elementId: member.elementId,
		patch: {
			trimStart: maxMediaTime({
				a: ZERO_MEDIA_TIME,
				b: addMediaTime({ a: member.trimStart, b: sourceDelta }),
			}),
			trimEnd: member.trimEnd,
			startTime: addMediaTime({ a: member.startTime, b: deltaTime }),
			duration: subMediaTime({ a: member.duration, b: deltaTime }),
		},
		};
	}

	return {
		trackId: member.trackId,
		elementId: member.elementId,
		patch: {
			trimStart: member.trimStart,
			trimEnd: maxMediaTime({
				a: ZERO_MEDIA_TIME,
				b: subMediaTime({ a: member.trimEnd, b: sourceDelta }),
			}),
			startTime: member.startTime,
			duration: addMediaTime({ a: member.duration, b: deltaTime }),
		},
	};
}

function getMinimumAllowedDeltaTime({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: MediaTime;
}): MediaTime {
	if (side === "right") {
		return subMediaTime({ a: minDuration, b: member.duration });
	}

	const leftNeighborFloor =
		member.leftNeighborBound !== null
			? subMediaTime({ a: member.leftNeighborBound, b: member.startTime })
			: subMediaTime({ a: ZERO_MEDIA_TIME, b: member.startTime });
	if (member.freeze || member.sourceDuration == null) {
		return leftNeighborFloor;
	}

	const maximumSourceExtension = subMediaTime({
		a: getDurationForVisibleSourceSpan({
			member,
			sourceSpan: addMediaTime({
				a: getVisibleSourceSpanForDuration({
					member,
					duration: member.duration,
				}),
				b: member.trimStart,
			}),
		}),
		b: member.duration,
	});
	return maxMediaTime({
		a: leftNeighborFloor,
		b: subMediaTime({ a: ZERO_MEDIA_TIME, b: maximumSourceExtension }),
	});
}

function getMaximumAllowedDeltaTime({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: MediaTime;
}): MediaTime | null {
	if (side === "left") {
		return subMediaTime({ a: member.duration, b: minDuration });
	}

	// The right neighbor is not a hard ceiling: overflowing it ripples the
	// follower elements right (see buildRipplePushUpdates). Only the source
	// extent can cap a right-side extension. Frozen frames hold a single
	// frame, so the source extent does not cap them either.
	if (member.freeze || member.sourceDuration == null) {
		return null;
	}

	const maximumVisibleSourceSpan = subMediaTime({
		a: getSourceDuration({ member }),
		b: member.trimStart,
	});
	const maximumDuration = getDurationForVisibleSourceSpan({
		member,
		sourceSpan: maximumVisibleSourceSpan,
	});
	return subMediaTime({
		a: maximumDuration,
		b: member.duration,
	});
}

function getSourceDeltaForClipDelta({
	member,
	clipDelta,
}: {
	member: GroupResizeMember;
	clipDelta: MediaTime;
}): MediaTime {
	if (!member.retime) {
		return clipDelta;
	}

	const sourceDelta =
		clipDelta >= 0
			? getSourceSpanAtClipTime({
					clipTime: clipDelta,
					retime: member.retime,
				})
			: -getSourceSpanAtClipTime({
					clipTime: Math.abs(clipDelta),
					retime: member.retime,
				});
	return roundMediaTime({ time: sourceDelta });
}

function getVisibleSourceSpanForDuration({
	member,
	duration,
}: {
	member: GroupResizeMember;
	duration: MediaTime;
}): MediaTime {
	if (!member.retime) {
		return duration;
	}

	return roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: duration,
			retime: member.retime,
		}),
	});
}

function getDurationForVisibleSourceSpan({
	member,
	sourceSpan,
}: {
	member: GroupResizeMember;
	sourceSpan: MediaTime;
}): MediaTime {
	if (!member.retime) {
		return sourceSpan;
	}

	return roundMediaTime({
		time: getTimelineDurationForSourceSpan({
			sourceSpan,
			retime: member.retime,
		}),
	});
}

function getSourceDuration({ member }: { member: GroupResizeMember }): MediaTime {
	if (member.sourceDuration != null) {
		return member.sourceDuration;
	}

	return addMediaTime({
		a: addMediaTime({
			a: member.trimStart,
			b: getVisibleSourceSpanForDuration({
			member,
			duration: member.duration,
			}),
		}),
		b: member.trimEnd,
	});
}

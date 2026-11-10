import {
	getSourceTimeAtClipTime,
	getTimelineDurationForSourceSpan,
	hasTimeRemap,
} from "@/retime/resolve";
import type { RetimeConfig, VideoElement } from "@/timeline/types";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";

const toTicks = (seconds: number): MediaTime =>
	mediaTimeFromSeconds({ seconds });
const toSeconds = (time: MediaTime): number => mediaTimeToSeconds({ time });

export function isSameSourceCut({
	outgoing,
	incoming,
}: {
	outgoing: VideoElement;
	incoming: VideoElement;
}): boolean {
	if (outgoing.mediaId !== incoming.mediaId) return false;
	const outgoingSourceEnd =
		outgoing.trimStart +
		getSourceTimeAtClipTime({
			clipTime: outgoing.duration,
			retime: outgoing.retime,
			animations: outgoing.animations,
		});
	return (
		Math.abs(incoming.trimStart - outgoingSourceEnd) < TICKS_PER_SECOND / 30
	);
}

export function computeSplitCenterLayout({
	outgoing,
	incoming,
	duration,
}: {
	outgoing: VideoElement;
	incoming: VideoElement;
	duration: number;
}) {
	if (
		hasTimeRemap({ animations: outgoing.animations }) ||
		hasTimeRemap({ animations: incoming.animations })
	) {
		throw new Error(
			"split-center does not support time-remapped elements; use a constant playback rate",
		);
	}

	const half = duration / 2;
	const outDuration = toSeconds(outgoing.duration);
	const inDuration = toSeconds(incoming.duration);
	if (outDuration < duration + half) {
		throw new Error(
			"split-center needs the outgoing element to be at least 1.5 times the transition duration",
		);
	}

	const sourceHalf = (retime: RetimeConfig | undefined) =>
		toSeconds(
			roundMediaTime({
				time: getSourceTimeAtClipTime({
					clipTime: toTicks(half),
					retime,
				}),
			}),
		);
	const outSourceHalf = sourceHalf(outgoing.retime);
	const inSourceHalf = sourceHalf(incoming.retime);
	const inTrimStart = toSeconds(incoming.trimStart);
	const inTrimEnd = toSeconds(incoming.trimEnd);
	const consumedTail = Math.min(inTrimEnd, inSourceHalf);
	const tailShortage = toSeconds(
		roundMediaTime({
			time: getTimelineDurationForSourceSpan({
				sourceSpan: toTicks(inSourceHalf - consumedTail),
				retime: incoming.retime,
			}),
		}),
	);
	const timelineShortenedBy = half + tailShortage;

	return {
		outgoingPatch: {
			duration: toTicks(outDuration - half),
			trimEnd: addMediaTime({
				a: outgoing.trimEnd,
				b: toTicks(outSourceHalf),
			}),
		},
		incomingPatch: {
			trimStart: toTicks(inTrimStart + inSourceHalf),
			trimEnd: toTicks(inTrimEnd - consumedTail),
			startTime: subMediaTime({ a: incoming.startTime, b: toTicks(half) }),
			duration: toTicks(inDuration - tailShortage),
		},
		followingStartDelta: toTicks(timelineShortenedBy),
		adjustment: {
			layout: "split-center",
			half,
			timelineShortenedBy,
			outgoingDuration: outDuration - half,
			incomingStartTime: toSeconds(incoming.startTime) - half,
			incomingTrimStart: inTrimStart + inSourceHalf,
			...(tailShortage > 0
				? { incomingDurationShortenedBy: tailShortage }
				: {}),
		},
	};
}

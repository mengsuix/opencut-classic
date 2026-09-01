import { EditorCore } from "@/core";
import { BatchCommand } from "@/commands/batch-command";
import { getSourceTimeAtClipTime } from "@/retime";
import type { CreateTimelineElement, VideoElement } from "@/timeline";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	roundMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { InsertElementCommand } from "./insert-element";
import { RippleShiftElementsCommand } from "./ripple-shift-elements";
import { SplitElementsCommand } from "./split-elements";

/**
 * Freeze frame: split the video at `time`, insert a frozen segment of
 * `duration` holding the frame at the split point, and ripple the remainder
 * right to make room. Composed from the existing split/ripple/insert commands
 * so undo restores the whole operation at once.
 */
export class FreezeFrameCommand extends BatchCommand {
	constructor({
		trackId,
		elementId,
		time,
		duration,
	}: {
		trackId: string;
		elementId: string;
		time: MediaTime;
		duration: MediaTime;
	}) {
		const editor = EditorCore.getInstance();
		const element = editor.timeline.getElementsWithTracks({
			elements: [{ trackId, elementId }],
		})[0]?.element;
		if (
			!element ||
			element.type !== "video" ||
			time <= element.startTime ||
			time >= element.startTime + element.duration ||
			duration <= 0
		) {
			super([]);
			return;
		}

		const clipTime = subMediaTime({ a: time, b: element.startTime });
		const sourceTimeAtFreeze = addMediaTime({
			a: element.trimStart,
			b: roundMediaTime({
				time: getSourceTimeAtClipTime({ clipTime, retime: element.retime }),
			}),
		});
		const freezeElement = buildFreezeElement({
			element,
			startTime: time,
			duration,
			sourceTimeAtFreeze,
		});

		super([
			new SplitElementsCommand({
				elements: [{ trackId, elementId }],
				splitTime: time,
				retainSide: "both",
			}),
			new RippleShiftElementsCommand({
				trackId,
				boundary: { direction: "right", afterTime: time },
				shiftAmount: duration,
			}),
			new InsertElementCommand({
				element: freezeElement,
				placement: { mode: "explicit", trackId },
			}),
		]);
	}
}

function buildFreezeElement({
	element,
	startTime,
	duration,
	sourceTimeAtFreeze,
}: {
	element: VideoElement;
	startTime: MediaTime;
	duration: MediaTime;
	sourceTimeAtFreeze: MediaTime;
}): CreateTimelineElement {
	const { id: _id, ...rest } = element;
	return {
		...rest,
		startTime,
		duration,
		trimStart: sourceTimeAtFreeze,
		// One tick of source remains available so trims stay consistent with the
		// source-extent invariant (`trimStart + span + trimEnd == sourceDuration`).
		trimEnd:
			element.sourceDuration != null
				? maxMediaTime({
						a: subMediaTime({
							a: subMediaTime({
								a: element.sourceDuration,
								b: sourceTimeAtFreeze,
							}),
							b: mediaTime({ ticks: 1 }),
						}),
						b: ZERO_MEDIA_TIME,
					})
				: ZERO_MEDIA_TIME,
		retime: undefined,
		animations: undefined,
		freeze: true,
		name: `${element.name} (freeze)`,
	};
}

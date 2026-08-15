import { EditorCore } from "@/core";
import { Command } from "@/commands/base-command";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import { updateTrackInSceneTracks } from "@/timeline";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type RippleShiftBoundary =
	| { direction: "right"; afterTime: MediaTime }
	| { direction: "left"; beforeTime: MediaTime };

/**
 * Shifts a chain of elements on a track to make room for a ripple edit:
 * - right: every element starting at or after `afterTime` moves right;
 * - left: every element starting before `beforeTime` moves left.
 *
 * Applies the track update directly (like SplitElementsCommand) instead of
 * going through the update pipeline: the pipeline's main-track "earliest
 * element stays at 0" enforce rule would otherwise snap shifted elements
 * back to the timeline start.
 */
export class RippleShiftElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly boundary: RippleShiftBoundary;
	private readonly shiftAmount: MediaTime;

	constructor({
		trackId,
		boundary,
		shiftAmount,
	}: {
		trackId: string;
		boundary: RippleShiftBoundary;
		shiftAmount: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.boundary = boundary;
		this.shiftAmount = shiftAmount;
	}

	execute(): undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		if (this.shiftAmount <= 0) {
			return undefined;
		}

		const updatedTracks = updateTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			update: <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
				({
					...track,
					elements: track.elements.map((element) =>
						this.shiftElement({ element }),
					),
				}) as TTrack,
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	private shiftElement<TElement extends TimelineTrack["elements"][number]>({
		element,
	}: {
		element: TElement;
	}): TElement {
		if (this.boundary.direction === "right") {
			if (element.startTime < this.boundary.afterTime) {
				return element;
			}
			return {
				...element,
				startTime: addMediaTime({
					a: element.startTime,
					b: this.shiftAmount,
				}),
			};
		}

		if (element.startTime >= this.boundary.beforeTime) {
			return element;
		}
		return {
			...element,
			startTime: maxMediaTime({
				a: ZERO_MEDIA_TIME,
				b: subMediaTime({
					a: element.startTime,
					b: this.shiftAmount,
				}),
			}),
		};
	}
}

import { EditorCore } from "@/core";
import { Command } from "@/commands/base-command";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import { updateTrackInSceneTracks } from "@/timeline";
import { addMediaTime, type MediaTime } from "@/wasm";

/**
 * Shifts every element on a track starting at or after `afterTime` right by
 * `shiftAmount`, opening room for a ripple insert. Applies the track update
 * directly (like SplitElementsCommand) instead of going through the update
 * pipeline: the pipeline's main-track "earliest element stays at 0" enforce
 * rule would otherwise snap shifted elements back to the timeline start.
 */
export class RippleShiftElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly afterTime: MediaTime;
	private readonly shiftAmount: MediaTime;

	constructor({
		trackId,
		afterTime,
		shiftAmount,
	}: {
		trackId: string;
		afterTime: MediaTime;
		shiftAmount: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.afterTime = afterTime;
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
						element.startTime >= this.afterTime
							? {
									...element,
									startTime: addMediaTime({
										a: element.startTime,
										b: this.shiftAmount,
									}),
								}
							: element,
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
}

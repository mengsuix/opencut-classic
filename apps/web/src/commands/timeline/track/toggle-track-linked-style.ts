import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { EditorCore } from "@/core";
import {
	findTrackInSceneTracks,
	updateTrackInSceneTracks,
} from "@/timeline";

export class ToggleTrackLinkedStyleCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const targetTrack = findTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
		});
		if (!targetTrack || targetTrack.type !== "text") {
			return;
		}

		const updatedTracks = updateTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			update: (track) => {
				if (track.type !== "text") {
					return track;
				}
				return { ...track, linkedStyle: !track.linkedStyle };
			},
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}

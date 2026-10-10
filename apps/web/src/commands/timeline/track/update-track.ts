import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import {
	canTrackBeHidden,
	canTrackHaveAudio,
	findTrackInSceneTracks,
	updateTrackInSceneTracks,
	type SceneTracks,
} from "@/timeline";

/**
 * Set 语义的轨道属性更新（供 bridge/agent 路径使用）。
 * 与 toggle 命令不同：幂等，调用方无需先读状态。
 */
export class UpdateTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private trackId: string,
		private patch: { muted?: boolean; hidden?: boolean; linkedStyle?: boolean },
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const targetTrack = findTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
		});
		if (!targetTrack) {
			return;
		}

		const { muted, hidden, linkedStyle } = this.patch;
		const updatedTracks = updateTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			update: (track) => {
				let next = track;
				if (typeof muted === "boolean" && canTrackHaveAudio(next)) {
					next = { ...next, muted } as typeof next;
				}
				if (typeof hidden === "boolean" && canTrackBeHidden(next)) {
					next = { ...next, hidden } as typeof next;
				}
				if (typeof linkedStyle === "boolean" && next.type === "text") {
					next = { ...next, linkedStyle } as typeof next;
				}
				return next;
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

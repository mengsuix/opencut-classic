import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";

/**
 * Moves a track one step within its own section: overlay tracks reorder
 * among overlay tracks (above the main track), audio tracks among audio
 * tracks (below the main track). The main track itself cannot be reordered.
 */
export class ReorderTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({
		trackId,
		direction,
	}: {
		trackId: string;
		direction: "up" | "down";
	}) {
		super();
		this.trackId = trackId;
		this.direction = direction;
	}

	private trackId: string;
	private direction: "up" | "down";

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = reorderInSection({
			tracks: this.savedState,
			trackId: this.trackId,
			direction: this.direction,
		});
		if (!updatedTracks) {
			return;
		}

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

function reorderInSection({
	tracks,
	trackId,
	direction,
}: {
	tracks: SceneTracks;
	trackId: string;
	direction: "up" | "down";
}): SceneTracks | null {
	// Visual order is overlay (top) → main → audio (bottom), so "up" means a
	// lower array index inside each section.
	const delta = direction === "up" ? -1 : 1;

	const overlayIndex = tracks.overlay.findIndex((track) => track.id === trackId);
	if (overlayIndex >= 0) {
		const next = [...tracks.overlay];
		const target = overlayIndex + delta;
		if (target < 0 || target >= next.length) return null;
		[next[overlayIndex], next[target]] = [next[target], next[overlayIndex]];
		return { ...tracks, overlay: next };
	}

	const audioIndex = tracks.audio.findIndex((track) => track.id === trackId);
	if (audioIndex >= 0) {
		const next = [...tracks.audio];
		const target = audioIndex + delta;
		if (target < 0 || target >= next.length) return null;
		[next[audioIndex], next[target]] = [next[target], next[audioIndex]];
		return { ...tracks, audio: next };
	}

	return null;
}

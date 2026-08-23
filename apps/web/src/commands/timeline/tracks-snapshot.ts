import {
	Command,
	describeElementTarget,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { EditorCore } from "@/core";

export class TracksSnapshotCommand extends Command {
	constructor({
		before,
		after,
	}: {
		before: SceneTracks;
		after: SceneTracks;
	}) {
		super();
		this.before = before;
		this.after = after;
		// Snapshot commands don't know their target — diff before/after so the
		// history panel can show which elements changed.
		const names: string[] = [];
		const afterTracks = [after.main, ...after.overlay, ...after.audio];
		for (const track of afterTracks) {
			for (const element of track.elements) {
				const beforeTrack = [before.main, ...before.overlay, ...before.audio].find(
					(item) => item.id === track.id,
				);
				const beforeElement = beforeTrack?.elements.find(
					(item) => item.id === element.id,
				);
				if (JSON.stringify(beforeElement) !== JSON.stringify(element)) {
					names.push(describeElementTarget(element));
				}
			}
		}
		if (names.length > 0) {
			this.historyDetail = [...new Set(names)].slice(0, 3).join("、");
		}
	}

	private before: SceneTracks;
	private after: SceneTracks;

	execute(): CommandResult | undefined {
		EditorCore.getInstance().timeline.updateTracks(this.after);
		return undefined;
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}

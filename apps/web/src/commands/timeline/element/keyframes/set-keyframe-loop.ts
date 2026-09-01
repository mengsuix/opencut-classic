import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { setChannelLoop } from "@/animation";
import { updateElementInSceneTracks } from "@/timeline";
import type { SceneTracks } from "@/timeline";
import type { AnimationPath } from "@/animation/types";

export class SetKeyframeLoopCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly propertyPath: AnimationPath;
	private readonly loop: boolean;

	constructor({
		trackId,
		elementId,
		propertyPath,
		loop,
	}: {
		trackId: string;
		elementId: string;
		propertyPath: AnimationPath;
		loop: boolean;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.propertyPath = propertyPath;
		this.loop = loop;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) => ({
				...element,
				animations: setChannelLoop({
					animations: element.animations,
					propertyPath: this.propertyPath,
					loop: this.loop,
				}),
			}),
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}

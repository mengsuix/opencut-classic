import { Command, type CommandResult } from "@/commands/base-command";
import { BatchCommand } from "@/commands/batch-command";
import { DeleteElementsCommand } from "@/commands/timeline/element/delete-elements";
import { EditorCore } from "@/core";
import { collectHtmlPresetInstances } from "@/timeline/element-utils";
import type { SceneTracks } from "@/timeline";
import type { HtmlPreset } from "@/project/types";

/**
 * Removes one HTML effect preset (the project-level template shelf).
 *
 * Timeline elements inserted from the preset keep their own html snapshot and
 * are NOT touched here — cascade deletion of those elements is composed by
 * buildRemoveHtmlPresetCommand below, so a single undo restores both.
 */
export class RemoveHtmlPresetCommand extends Command {
	private savedPresets: HtmlPreset[] | null = null;

	constructor(private readonly presetId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedPresets = editor.project.getHtmlPresets();
		editor.project.setHtmlPresets({
			presets: this.savedPresets.filter(
				(preset) => preset.id !== this.presetId,
			),
		});
		return undefined;
	}

	undo(): void {
		if (!this.savedPresets) return;
		EditorCore.getInstance().project.setHtmlPresets({
			presets: this.savedPresets,
		});
	}
}

/**
 * The command that removes a preset together with every timeline element
 * inserted from it. One undo restores the preset and all cascaded elements.
 * Lives here so the effects panel and the agent bridge cascade identically.
 */
export function buildRemoveHtmlPresetCommand({
	tracks,
	presetId,
}: {
	tracks: SceneTracks;
	presetId: string;
}): {
	command: Command;
	instances: { trackId: string; elementId: string }[];
} {
	const instances = collectHtmlPresetInstances({ tracks, presetId });
	const removePreset = new RemoveHtmlPresetCommand(presetId);
	const command: Command =
		instances.length > 0
			? new BatchCommand([
					new DeleteElementsCommand({ elements: instances }),
					removePreset,
				])
			: removePreset;
	command.affectedElementRefs = instances;
	return { command, instances };
}

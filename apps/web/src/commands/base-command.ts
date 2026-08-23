import type { EditorSelectionPatch } from "@/selection/editor-selection";
import type { ElementRef } from "@/timeline/types";

export interface CommandResult {
	selection?: EditorSelectionPatch;
}

export function createElementSelectionResult(
	selectedElements: ElementRef[],
): CommandResult {
	return {
		selection: {
			selectedElements,
			selectedKeyframes: [],
			keyframeSelectionAnchor: null,
			selectedMaskPoints: null,
		},
	};
}

const MAX_TARGET_TEXT_LENGTH = 12;

/** Describe an element as a history target: text elements show their content
 *  excerpt, others show their name. */
export function describeElementTarget(element: {
	type?: string;
	name?: string;
	params?: unknown;
}): string {
	const params = element.params as Record<string, unknown> | undefined;
	const content = params?.content;
	if (
		element.type === "text" &&
		typeof content === "string" &&
		content.trim().length > 0
	) {
		const trimmed = content.trim();
		const excerpt =
			trimmed.length > MAX_TARGET_TEXT_LENGTH
				? `${trimmed.slice(0, MAX_TARGET_TEXT_LENGTH)}…`
				: trimmed;
		return `「${excerpt}」`;
	}
	return element.name ?? "元素";
}

export abstract class Command {
	/** Element refs the command operates on. The history panel resolves them
	 *  to element names before execution to show what was affected. */
	public affectedElementRefs?: ElementRef[];
	/** Target description for commands whose target does not exist before
	 *  execution (e.g. insert). Takes precedence over affectedElementRefs. */
	public historyDetail?: string;

	abstract execute(): CommandResult | undefined;

	undo(): void {
		throw new Error("Undo not implemented for this command");
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}
}

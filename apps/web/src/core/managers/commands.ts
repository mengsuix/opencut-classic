import type { EditorCore } from "@/core";
import { describeElementTarget } from "@/commands/base-command";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";

export interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
	label: string;
	source: "user" | "agent";
	timestamp: number;
	targets?: string[];
}

export interface CommandExecutionMeta {
	source: "user" | "agent";
	label?: string;
}

export class CommandManager {
	public isRippleEnabled = false;
	/** Set by the bridge before running a command so history entries are
	 *  attributed correctly. Cleared by the caller in a finally block. */
	public currentMeta: CommandExecutionMeta | null = null;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	private buildEntry({
		command,
		previousSelection,
		selectionOverride,
		targets,
	}: {
		command: Command;
		previousSelection: EditorSelectionSnapshot;
		selectionOverride?: EditorSelectionSnapshot;
		targets?: string[];
	}): CommandHistoryEntry {
		return {
			command,
			previousSelection,
			...(selectionOverride !== undefined ? { selectionOverride } : {}),
			...(targets !== undefined ? { targets } : {}),
			label: this.currentMeta?.label ?? command.constructor.name,
			source: this.currentMeta?.source ?? "user",
			timestamp: Date.now(),
		};
	}

	/** Resolve the command's target elements to display names. Must be called
	 *  before execution — delete-type commands remove their targets. */
	private describeTargets(command: Command): string[] | undefined {
		if (command.historyDetail) {
			return [command.historyDetail];
		}
		const refs = command.affectedElementRefs;
		if (!refs || refs.length === 0) {
			return undefined;
		}
		const tracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!tracks) {
			return undefined;
		}
		const allTracks = [tracks.main, ...tracks.overlay, ...tracks.audio];
		const names: string[] = [];
		for (const ref of refs) {
			const track = allTracks.find((item) => item.id === ref.trackId);
			const element = track?.elements.find(
				(item) => item.id === ref.elementId,
			);
			if (!element) {
				continue;
			}
			names.push(describeElementTarget(element));
		}
		return names.length > 0 ? [...new Set(names)] : undefined;
	}

	execute({ command }: { command: Command }): Command {
		const targets = this.describeTargets(command);
		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.history.push(
			this.buildEntry({
				command,
				previousSelection,
				selectionOverride,
				targets,
			}),
		);
		this.redoStack = [];
		this.notify();
		return command;
	}

	push({ command }: { command: Command }): void {
		// Best-effort: the command already ran, so delete-type targets are gone.
		const targets = this.describeTargets(command);
		this.history.push(
			this.buildEntry({
				command,
				previousSelection: this.getSelectionSnapshot(),
				targets,
			}),
		);
		this.redoStack = [];
		this.notify();
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): CommandHistoryEntry | undefined {
		if (this.history.length === 0) return undefined;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
		}
		this.notify();
		return entry;
	}

	redo(): CommandHistoryEntry | undefined {
		if (this.redoStack.length === 0) return undefined;
		const entry = this.redoStack.pop();
		if (!entry) {
			return undefined;
		}

		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		const rebuilt = this.buildEntry({
			command: entry.command,
			previousSelection,
			selectionOverride,
		});
		rebuilt.label = entry.label;
		rebuilt.source = entry.source;
		this.history.push(rebuilt);
		this.notify();
		return entry;
	}

	/** Jump to a history position: 0 = nothing applied, history.length = all
	 *  applied. Undoes or redoes as needed. */
	jumpTo({ targetLength }: { targetLength: number }): void {
		const total = this.history.length + this.redoStack.length;
		const clamped = Math.max(0, Math.min(targetLength, total));
		while (this.history.length > clamped) {
			this.undo();
		}
		while (this.history.length < clamped && this.redoStack.length > 0) {
			this.redo();
		}
	}

	getHistory(): readonly CommandHistoryEntry[] {
		return this.history;
	}

	getRedoStack(): readonly CommandHistoryEntry[] {
		return this.redoStack;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
		this.notify();
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private applyRippleIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!this.isRippleEnabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}

import type { ShortcutKey } from "@/actions/keybinding";
import { t } from "@/i18n";
import type { TActionWithOptionalArgs } from "./types";

export type TActionCategory =
	| "playback"
	| "navigation"
	| "editing"
	| "selection"
	| "history"
	| "timeline"
	| "controls"
	| "assets";

export interface TActionBaseDefinition {
	description: string;
	category: TActionCategory;
	args?: Record<string, unknown>;
}

export interface TActionDefinition extends TActionBaseDefinition {
	defaultShortcuts?: readonly ShortcutKey[];
}

export const ACTIONS = {
	"toggle-play": {
		get description() {
			return t("shell.actionTogglePlay");
		},
		category: "playback",
	},
	"stop-playback": {
		get description() {
			return t("shell.actionStopPlayback");
		},
		category: "playback",
	},
	"seek-forward": {
		get description() {
			return t("shell.actionSeekForward");
		},
		category: "playback",
		args: { seconds: "number" },
	},
	"seek-backward": {
		get description() {
			return t("shell.actionSeekBackward");
		},
		category: "playback",
		args: { seconds: "number" },
	},
	"frame-step-forward": {
		get description() {
			return t("shell.actionFrameStepForward");
		},
		category: "navigation",
	},
	"frame-step-backward": {
		get description() {
			return t("shell.actionFrameStepBackward");
		},
		category: "navigation",
	},
	"jump-forward": {
		get description() {
			return t("shell.actionJumpForward");
		},
		category: "navigation",
		args: { seconds: "number" },
	},
	"jump-backward": {
		get description() {
			return t("shell.actionJumpBackward");
		},
		category: "navigation",
		args: { seconds: "number" },
	},
	"goto-start": {
		get description() {
			return t("shell.actionGotoStart");
		},
		category: "navigation",
	},
	"goto-end": {
		get description() {
			return t("shell.actionGotoEnd");
		},
		category: "navigation",
	},
	split: {
		get description() {
			return t("shell.actionSplit");
		},
		category: "editing",
	},
	"split-left": {
		get description() {
			return t("shell.actionSplitLeft");
		},
		category: "editing",
	},
	"split-right": {
		get description() {
			return t("shell.actionSplitRight");
		},
		category: "editing",
	},
	"delete-selected": {
		get description() {
			return t("shell.actionDeleteSelected");
		},
		category: "editing",
	},
	"copy-selected": {
		get description() {
			return t("shell.actionCopySelected");
		},
		category: "editing",
	},
	"paste-copied": {
		get description() {
			return t("shell.actionPasteCopied");
		},
		category: "editing",
	},
	"toggle-snapping": {
		get description() {
			return t("shell.actionToggleSnapping");
		},
		category: "editing",
	},
	"toggle-ripple-editing": {
		get description() {
			return t("shell.actionToggleRippleEditing");
		},
		category: "editing",
	},
	"toggle-source-audio": {
		get description() {
			return t("shell.actionToggleSourceAudio");
		},
		category: "editing",
	},
	"select-all": {
		get description() {
			return t("shell.actionSelectAll");
		},
		category: "selection",
	},
	"cancel-interaction": {
		get description() {
			return t("shell.actionCancelInteraction");
		},
		category: "controls",
	},
	"deselect-all": {
		get description() {
			return t("shell.actionDeselectAll");
		},
		category: "selection",
	},
	"duplicate-selected": {
		get description() {
			return t("shell.actionDuplicateSelected");
		},
		category: "selection",
	},
	"freeze-frame": {
		get description() {
			return t("shell.actionFreezeFrame");
		},
		category: "timeline",
	},
	"toggle-elements-muted-selected": {
		get description() {
			return t("shell.actionToggleMutedSelected");
		},
		category: "selection",
	},
	"toggle-elements-visibility-selected": {
		get description() {
			return t("shell.actionToggleVisibilitySelected");
		},
		category: "selection",
	},
	"toggle-bookmark": {
		get description() {
			return t("shell.actionToggleBookmark");
		},
		category: "timeline",
	},
	undo: {
		get description() {
			return t("shell.actionUndo");
		},
		category: "history",
	},
	redo: {
		get description() {
			return t("shell.actionRedo");
		},
		category: "history",
	},
	"remove-media-asset": {
		get description() {
			return t("shell.actionRemoveMediaAsset");
		},
		category: "assets",
		args: { projectId: "string", assetId: "string" },
	},
	"remove-media-assets": {
		get description() {
			return t("shell.actionRemoveMediaAssets");
		},
		category: "assets",
		args: { projectId: "string", assetIds: "string[]" },
	},
} as const satisfies Record<string, TActionBaseDefinition>;

export type TAction = keyof typeof ACTIONS;

const ACTION_DEFAULT_SHORTCUTS = [
	["toggle-play", ["space", "k"]],
	["seek-forward", ["l"]],
	["seek-backward", ["j"]],
	["frame-step-forward", ["right"]],
	["frame-step-backward", ["left"]],
	["jump-forward", ["shift+right"]],
	["jump-backward", ["shift+left"]],
	["goto-start", ["home", "enter"]],
	["goto-end", ["end"]],
	["split", ["s"]],
	["split-left", ["q"]],
	["split-right", ["w"]],
	["delete-selected", ["backspace", "delete"]],
	["copy-selected", ["ctrl+c"]],
	["paste-copied", ["ctrl+v"]],
	["toggle-snapping", ["n"]],
	["select-all", ["ctrl+a"]],
	["cancel-interaction", ["escape"]],
	["duplicate-selected", ["ctrl+d"]],
	["undo", ["ctrl+z"]],
	["redo", ["ctrl+shift+z", "ctrl+y"]],
] as const satisfies ReadonlyArray<
	readonly [TActionWithOptionalArgs, readonly ShortcutKey[]]
>;

const ACTION_DEFAULT_SHORTCUTS_BY_ACTION = new Map<
	TAction,
	readonly ShortcutKey[]
>(ACTION_DEFAULT_SHORTCUTS);

export function getActionDefinition({
	action,
}: {
	action: TAction;
}): TActionDefinition {
	return {
		...ACTIONS[action],
		defaultShortcuts: ACTION_DEFAULT_SHORTCUTS_BY_ACTION.get(action),
	};
}

export function getDefaultShortcuts(): Map<
	ShortcutKey,
	TActionWithOptionalArgs
> {
	const shortcuts = new Map<ShortcutKey, TActionWithOptionalArgs>();

	for (const [action, defaultShortcuts] of ACTION_DEFAULT_SHORTCUTS) {
		for (const shortcut of defaultShortcuts) {
			shortcuts.set(shortcut, action);
		}
	}

	return shortcuts;
}

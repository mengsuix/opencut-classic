import { getPersistedKeybindingsState } from "../persisted-state";

export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = getPersistedKeybindingsState({ state });
	if (!v7) return state;
	if (v7.isCustomized || v7.keybindings.r !== undefined) return v7;

	return {
		...v7,
		keybindings: { ...v7.keybindings, r: "toggle-ripple-editing" },
	};
}

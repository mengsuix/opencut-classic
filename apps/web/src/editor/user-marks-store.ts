import { create } from "zustand";

/** Transient visual-marking gestures. Committed C/T marks live in ai-chat-store. */
export interface TimeRangeInput {
	startTime: number;
	endTime: number;
}

interface UserMarksState {
	/** In-progress drag range while marking; shown as a draft band. */
	draftTimeRange: TimeRangeInput | null;
	isRegionMarking: boolean;
	isRangeMarking: boolean;
	setDraftTimeRange: (range: TimeRangeInput | null) => void;
	setRegionMarking: (active: boolean) => void;
	setRangeMarking: (active: boolean) => void;
}

export const useUserMarksStore = create<UserMarksState>()((set) => ({
	draftTimeRange: null,
	isRegionMarking: false,
	isRangeMarking: false,
	setDraftTimeRange: (range) => set({ draftTimeRange: range }),
	setRegionMarking: (active) => set({ isRegionMarking: active }),
	// Turning the mode off (toolbar toggle, Escape, drag finished) also drops
	// any in-progress draft so a cancelled gesture never lingers on screen.
	setRangeMarking: (active) =>
		set(active
			? { isRangeMarking: true }
			: { isRangeMarking: false, draftTimeRange: null }),
}));

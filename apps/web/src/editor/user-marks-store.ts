import { create } from "zustand";

/**
 * User-drawn visual marks for referring to regions of the project in natural
 * language ("这块区域 / 这一段"). Pure UI state: not persisted, not part of
 * project data, not undoable. Read by the agent bridge (marks.get) and
 * cleared via marks.clear.
 */
export interface CanvasRectMark {
	/** Canvas fractions 0~1, top-left origin — same coordinate system as masks.set_canvas_rect. */
	left: number;
	top: number;
	right: number;
	bottom: number;
	/** Playhead position in seconds when the rect was drawn. */
	time: number;
}

export interface TimeRangeMark {
	/** Timeline seconds. */
	startTime: number;
	endTime: number;
}

interface UserMarksState {
	canvasRect: CanvasRectMark | null;
	timeRange: TimeRangeMark | null;
	/** In-progress drag range while marking; shown as a draft band. */
	draftTimeRange: TimeRangeMark | null;
	isRegionMarking: boolean;
	isRangeMarking: boolean;
	setCanvasRect: (rect: CanvasRectMark) => void;
	setTimeRange: (range: TimeRangeMark) => void;
	setDraftTimeRange: (range: TimeRangeMark | null) => void;
	setRegionMarking: (active: boolean) => void;
	setRangeMarking: (active: boolean) => void;
	clearCanvasRect: () => void;
	clearTimeRange: () => void;
}

export const useUserMarksStore = create<UserMarksState>()((set) => ({
	canvasRect: null,
	timeRange: null,
	draftTimeRange: null,
	isRegionMarking: false,
	isRangeMarking: false,
	setCanvasRect: (rect) => set({ canvasRect: rect }),
	setTimeRange: (range) => set({ timeRange: range }),
	setDraftTimeRange: (range) => set({ draftTimeRange: range }),
	setRegionMarking: (active) => set({ isRegionMarking: active }),
	setRangeMarking: (active) => set({ isRangeMarking: active }),
	clearCanvasRect: () => set({ canvasRect: null }),
	clearTimeRange: () => set({ timeRange: null }),
}));

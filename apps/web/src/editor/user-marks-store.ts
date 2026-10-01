import { create } from "zustand";

/**
 * User-drawn visual marks for referring to regions of the project in natural
 * language ("这块区域 / 这一段"). Pure UI state: not persisted, not part of
 * project data, not undoable. Read by the agent bridge (marks.get) and
 * cleared via marks.clear.
 *
 * Marks are labeled per kind — canvas rects "C1", "C2", … and time ranges
 * "T1", "T2", … — so the user can point at one in conversation ("C1 这块").
 * Numbers keep increasing while marks of that kind exist (a deleted label is
 * not handed out again) and restart at 1 when none are left.
 */
let nextCanvasRectId = 1;
let nextTimeRangeId = 1;

export interface CanvasRectMark {
	/** Display label like C1/C2, shown on the rect in the preview. */
	id: string;
	/** Canvas fractions 0~1, top-left origin — same coordinate system as masks.set_canvas_rect. */
	left: number;
	top: number;
	right: number;
	bottom: number;
	/** Playhead position in seconds when the rect was drawn. */
	time: number;
}

export type CanvasRectInput = Omit<CanvasRectMark, "id">;

export interface TimeRangeMark {
	/** Display label like T1/T2, shown on the band in the ruler. */
	id: string;
	/** Timeline seconds. */
	startTime: number;
	endTime: number;
}

export type TimeRangeInput = Omit<TimeRangeMark, "id">;

interface UserMarksState {
	canvasRects: CanvasRectMark[];
	timeRanges: TimeRangeMark[];
	/** In-progress drag range while marking; shown as a draft band. */
	draftTimeRange: TimeRangeInput | null;
	isRegionMarking: boolean;
	isRangeMarking: boolean;
	addCanvasRect: (rect: CanvasRectInput) => void;
	removeCanvasRect: (id: string) => void;
	clearCanvasRects: () => void;
	addTimeRange: (range: TimeRangeInput) => void;
	removeTimeRange: (id: string) => void;
	clearTimeRanges: () => void;
	setDraftTimeRange: (range: TimeRangeInput | null) => void;
	setRegionMarking: (active: boolean) => void;
	setRangeMarking: (active: boolean) => void;
}

export const useUserMarksStore = create<UserMarksState>()((set, get) => ({
	canvasRects: [],
	timeRanges: [],
	draftTimeRange: null,
	isRegionMarking: false,
	isRangeMarking: false,
	addCanvasRect: (rect) =>
		set((state) => ({
			canvasRects: [
				...state.canvasRects,
				{ ...rect, id: `C${nextCanvasRectId++}` },
			],
		})),
	removeCanvasRect: (id) => {
		set((state) => ({
			canvasRects: state.canvasRects.filter((rect) => rect.id !== id),
		}));
		if (get().canvasRects.length === 0) {
			nextCanvasRectId = 1;
		}
	},
	clearCanvasRects: () => {
		nextCanvasRectId = 1;
		set({ canvasRects: [] });
	},
	addTimeRange: (range) =>
		set((state) => ({
			timeRanges: [
				...state.timeRanges,
				{ ...range, id: `T${nextTimeRangeId++}` },
			],
		})),
	removeTimeRange: (id) => {
		set((state) => ({
			timeRanges: state.timeRanges.filter((range) => range.id !== id),
		}));
		if (get().timeRanges.length === 0) {
			nextTimeRangeId = 1;
		}
	},
	clearTimeRanges: () => {
		nextTimeRangeId = 1;
		set({ timeRanges: [] });
	},
	setDraftTimeRange: (range) => set({ draftTimeRange: range }),
	setRegionMarking: (active) => set({ isRegionMarking: active }),
	// Turning the mode off (toolbar toggle, Escape, drag finished) also drops
	// any in-progress draft so a cancelled gesture never lingers on screen.
	setRangeMarking: (active) =>
		set(active
			? { isRangeMarking: true }
			: { isRangeMarking: false, draftTimeRange: null }),
}));

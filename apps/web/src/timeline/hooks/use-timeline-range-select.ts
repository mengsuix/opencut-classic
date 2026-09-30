import { useEffect, useRef } from "react";
import { mediaTimeToSeconds } from "opencut-wasm";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { useEditor } from "@/editor/use-editor";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { clamp } from "@/utils/math";

const MIN_RANGE_PX = 2;

interface DragSession {
	handleMove: (e: MouseEvent) => void;
	handleUp: (e: MouseEvent) => void;
}

/**
 * Drag anywhere on the timeline (ruler, bookmarks row or tracks) in
 * range-marking mode selects a time-range mark for the agent to reference.
 * Started from the timeline toolbar button (same interaction as the preview's
 * canvas region marking). The drag listens on window after mousedown; the mode
 * exits once the drag is released, so marking another range requires pressing
 * the toolbar button again. The draft band lives in the store so it renders
 * consistently on the ruler regardless of where the drag started.
 */
export function useTimelineRangeSelect({
	getRulerEl,
	zoomLevel,
}: {
	getRulerEl: () => HTMLDivElement | null;
	zoomLevel: number;
}) {
	const editor = useEditor();
	const setDraftTimeRange = useUserMarksStore((s) => s.setDraftTimeRange);
	const addTimeRange = useUserMarksStore((s) => s.addTimeRange);
	const setRangeMarking = useUserMarksStore((s) => s.setRangeMarking);

	const sessionRef = useRef<DragSession | null>(null);
	// Latest pointer X during a drag; read by the edge auto-scroll loop.
	const lastMouseXRef = useRef(0);
	// A mousedown consumed by marking pairs with a click that must not reach
	// the element/track underneath. Records the mouseup timestamp (which always
	// precedes the click); the suppression expires quickly so a gesture that
	// never produced a click (released outside the window) can't swallow an
	// unrelated later click.
	const suppressClickAfterRef = useRef(0);

	const endSession = () => {
		const session = sessionRef.current;
		if (!session) return;
		sessionRef.current = null;
		window.removeEventListener("mousemove", session.handleMove);
		window.removeEventListener("mouseup", session.handleUp);
	};

	// If the component unmounts mid-drag (scene switch, panel close) the
	// window listeners must not outlive it.
	useEffect(() => endSession, []);

	const onRangeSelectMouseDown = (event: React.MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();

		const rulerEl = getRulerEl();
		if (!rulerEl) return;

		// Defensive: a previous gesture that never saw its mouseup (released
		// outside the window) leaves listeners behind — drop them first.
		endSession();

		const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
		// Read the ruler position and the duration per event, not once at
		// mousedown: horizontal scrolling (edge auto-scroll, trackpad) moves
		// the ruler mid-drag, and this component does not re-render on
		// duration changes so a captured duration would go stale.
		const toSeconds = (clientX: number) => {
			const el = getRulerEl();
			if (!el) return 0;
			const duration = mediaTimeToSeconds({
				time: editor.timeline.getTotalDuration(),
			});
			return clamp({
				value: (clientX - el.getBoundingClientRect().left) / pixelsPerSecond,
				min: 0,
				max: duration,
			});
		};

		const anchor = toSeconds(event.clientX);
		lastMouseXRef.current = event.clientX;
		setDraftTimeRange({ startTime: anchor, endTime: anchor });

		const handleMove = (e: MouseEvent) => {
			// Escape exited the mode mid-drag (and cleared the draft) — the
			// gesture is cancelled; don't resurrect the draft.
			if (!useUserMarksStore.getState().isRangeMarking) return;
			lastMouseXRef.current = e.clientX;
			const current = toSeconds(e.clientX);
			setDraftTimeRange({
				startTime: Math.min(anchor, current),
				endTime: Math.max(anchor, current),
			});
		};
		const handleUp = (e: MouseEvent) => {
			endSession();
			suppressClickAfterRef.current = e.timeStamp;
			// Mode exited mid-drag (Escape) — discard instead of committing.
			if (!useUserMarksStore.getState().isRangeMarking) {
				setDraftTimeRange(null);
				return;
			}
			const current = toSeconds(e.clientX);
			const range = {
				startTime: Math.min(anchor, current),
				endTime: Math.max(anchor, current),
			};
			setDraftTimeRange(null);
			if ((range.endTime - range.startTime) * pixelsPerSecond >= MIN_RANGE_PX) {
				addTimeRange(range);
			}
			setRangeMarking(false);
		};

		sessionRef.current = { handleMove, handleUp };
		window.addEventListener("mousemove", handleMove);
		window.addEventListener("mouseup", handleUp);
	};

	const onRangeSelectClickCapture = (event: React.MouseEvent) => {
		const armedAt = suppressClickAfterRef.current;
		suppressClickAfterRef.current = 0;
		if (armedAt === 0) return;
		// A real mouseup→click pair lands within milliseconds; anything later
		// is a new, unrelated click.
		if (event.timeStamp - armedAt > 500) return;
		event.preventDefault();
		event.stopPropagation();
	};

	return { onRangeSelectMouseDown, onRangeSelectClickCapture, lastMouseXRef };
}

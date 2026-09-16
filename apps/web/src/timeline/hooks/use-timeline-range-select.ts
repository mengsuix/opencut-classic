import { mediaTimeToSeconds } from "opencut-wasm";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { useEditor } from "@/editor/use-editor";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { clamp } from "@/utils/math";

const MIN_RANGE_PX = 2;

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

	const durationSeconds = mediaTimeToSeconds({
		time: editor.timeline.getTotalDuration(),
	});

	const onRangeSelectMouseDown = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();

		const rulerEl = getRulerEl();
		if (!rulerEl) return;
		const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
		const rulerLeft = rulerEl.getBoundingClientRect().left;
		const duration = durationSeconds;

		const toSeconds = (clientX: number) =>
			clamp({
				value: (clientX - rulerLeft) / pixelsPerSecond,
				min: 0,
				max: duration,
			});

		const anchor = toSeconds(event.clientX);
		setDraftTimeRange({ startTime: anchor, endTime: anchor });

		const handleMove = (e: MouseEvent) => {
			const current = toSeconds(e.clientX);
			setDraftTimeRange({
				startTime: Math.min(anchor, current),
				endTime: Math.max(anchor, current),
			});
		};
		const handleUp = (e: MouseEvent) => {
			window.removeEventListener("mousemove", handleMove);
			window.removeEventListener("mouseup", handleUp);
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

		window.addEventListener("mousemove", handleMove);
		window.addEventListener("mouseup", handleUp);
	};

	return { onRangeSelectMouseDown };
}

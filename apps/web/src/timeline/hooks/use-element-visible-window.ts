import { useCallback, useRef, useSyncExternalStore } from "react";
import { timelineViewport } from "@/timeline/viewport-store";

/** Extra pixels rendered beyond the viewport so small scrolls stay covered. */
const ELEMENT_WINDOW_OVERSCAN_PX = 512;

/** Window bounds are snapped to this grid to bound re-render frequency. */
const WINDOW_STEP_PX = 256;

export interface ElementWindow {
	/** Left edge of the visible region, in element-local pixels. */
	leftPx: number;
	/** Right edge of the visible region, in element-local pixels. */
	rightPx: number;
	/** False when the element is entirely offscreen. */
	isVisible: boolean;
}

const HIDDEN: ElementWindow = { leftPx: 0, rightPx: 0, isVisible: false };

function snapDown({ value }: { value: number }): number {
	return Math.floor(value / WINDOW_STEP_PX) * WINDOW_STEP_PX;
}

function snapUp({ value }: { value: number }): number {
	return Math.ceil(value / WINDOW_STEP_PX) * WINDOW_STEP_PX;
}

/**
 * Returns the portion of an element that is currently on screen, expressed in
 * element-local pixels.
 *
 * Elements can be millions of pixels wide at high zoom; rendering their content
 * across that whole span is what makes deep-zoom scrolling stutter. Consumers use
 * this window to render only what is visible while the element box keeps its true
 * width for layout and hit testing.
 */
export function useElementVisibleWindow({
	elementLeftPx,
	elementWidthPx,
}: {
	elementLeftPx: number;
	elementWidthPx: number;
}): ElementWindow {
	const cacheRef = useRef<ElementWindow>(HIDDEN);

	const getSnapshot = useCallback((): ElementWindow => {
		// Reads the quantized viewport, not the live one: it only changes when a
		// notification fires, so the snapshot stays consistent within a render pass.
		const { scrollLeft, viewportWidth } = timelineViewport.quantizedViewport;
		const previous = cacheRef.current;

		if (elementWidthPx <= 0 || viewportWidth <= 0) {
			if (previous.isVisible) {
				cacheRef.current = HIDDEN;
				return HIDDEN;
			}
			return previous;
		}

		const windowLeft = scrollLeft - ELEMENT_WINDOW_OVERSCAN_PX - elementLeftPx;
		const windowRight =
			scrollLeft + viewportWidth + ELEMENT_WINDOW_OVERSCAN_PX - elementLeftPx;

		const rawLeft = Math.max(0, windowLeft);
		const rawRight = Math.min(elementWidthPx, windowRight);

		if (rawRight <= rawLeft) {
			if (previous.isVisible) {
				cacheRef.current = HIDDEN;
				return HIDDEN;
			}
			return previous;
		}

		const leftPx = Math.max(0, snapDown({ value: rawLeft }));
		const rightPx = Math.min(elementWidthPx, snapUp({ value: rawRight }));

		if (
			previous.isVisible &&
			previous.leftPx === leftPx &&
			previous.rightPx === rightPx
		) {
			return previous;
		}

		const next: ElementWindow = { leftPx, rightPx, isVisible: true };
		cacheRef.current = next;
		return next;
	}, [elementLeftPx, elementWidthPx]);

	return useSyncExternalStore(
		useCallback(
			(onChange: () => void) => timelineViewport.subscribeQuantized(onChange),
			[],
		),
		getSnapshot,
		getSnapshot,
	);
}

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
	timelineViewport,
	type TimelineViewport,
} from "@/timeline/viewport-store";

/**
 * Binds the shared viewport store to the timeline's scroll container.
 * Must be called exactly once, by the component that owns the scroll element.
 */
export function useBindTimelineViewport({
	scrollRef,
}: {
	scrollRef: React.RefObject<HTMLElement | null>;
}): void {
	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		return timelineViewport.attach({ element });
	}, [scrollRef]);
}

/**
 * Re-renders only when the viewport crosses a quantization bucket. Use for
 * windowed rendering (ruler ticks, virtualized rows) where being a few hundred
 * pixels early is fine but re-rendering every frame is not.
 */
export function useQuantizedTimelineViewport(): TimelineViewport {
	return useSyncExternalStore(
		useCallback(
			(onChange: () => void) => timelineViewport.subscribeQuantized(onChange),
			[],
		),
		() => timelineViewport.quantizedViewport,
		() => timelineViewport.quantizedViewport,
	);
}

/**
 * Subscribes an imperative callback to every rAF-batched viewport change.
 * The callback must only touch the DOM — never trigger a React update from it.
 */
export function useRawTimelineViewport(
	onViewportChange: (viewport: TimelineViewport) => void,
): void {
	useEffect(() => {
		const notify = () => onViewportChange(timelineViewport.cached);
		notify();
		return timelineViewport.subscribeRaw(notify);
	}, [onViewportChange]);
}

"use client";

/**
 * Single source of truth for the timeline's scroll viewport.
 *
 * Scroll events fire far more often than once per frame, and every consumer
 * that reads `scrollLeft` through React state forces a re-render of the whole
 * timeline tree. This store collapses all of that into one rAF-batched read:
 *
 * - Imperative consumers (playhead, waveform canvases) subscribe with
 *   `subscribeRaw` and mutate DOM directly — zero React work.
 * - Consumers that must re-render (ruler, virtualized rows) subscribe with
 *   `subscribeQuantized`, which only notifies when the visible window crosses
 *   a bucket boundary, so scrolling a few pixels costs nothing.
 */

/** Window bucket size. Scrolling within one bucket never re-renders React. */
const QUANTIZE_STEP_PX = 256;

export interface TimelineViewport {
	scrollLeft: number;
	scrollTop: number;
	viewportWidth: number;
	viewportHeight: number;
}

const EMPTY_VIEWPORT: TimelineViewport = {
	scrollLeft: 0,
	scrollTop: 0,
	viewportWidth: 0,
	viewportHeight: 0,
};

function quantizeDown({ value }: { value: number }): number {
	return Math.floor(value / QUANTIZE_STEP_PX) * QUANTIZE_STEP_PX;
}

function quantizeUp({ value }: { value: number }): number {
	return Math.ceil(value / QUANTIZE_STEP_PX) * QUANTIZE_STEP_PX;
}

class TimelineViewportStore {
	private element: HTMLElement | null = null;
	private viewport: TimelineViewport = EMPTY_VIEWPORT;

	/** Quantized snapshot; only replaced when a bucket boundary is crossed. */
	private quantized: TimelineViewport = EMPTY_VIEWPORT;

	private readonly rawSubscribers = new Set<() => void>();
	private readonly quantizedSubscribers = new Set<() => void>();

	private rafId: number | null = null;
	private resizeObserver: ResizeObserver | null = null;

	constructor() {
		this.handleScroll = this.handleScroll.bind(this);
		this.flush = this.flush.bind(this);
	}

	/**
	 * Binds the store to the timeline's scroll container. Returns a cleanup
	 * function; safe to call repeatedly (rebinds).
	 */
	attach({ element }: { element: HTMLElement }): () => void {
		this.detach();
		this.element = element;

		element.addEventListener("scroll", this.handleScroll, { passive: true });

		this.resizeObserver = new ResizeObserver(() => {
			this.readNow();
		});
		this.resizeObserver.observe(element);

		this.readNow();

		return () => {
			if (this.element === element) {
				this.detach();
			}
		};
	}

	private detach(): void {
		if (this.element) {
			this.element.removeEventListener("scroll", this.handleScroll);
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.element = null;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	/** Live viewport. Reads the DOM directly so callers never see a stale frame. */
	get current(): TimelineViewport {
		const element = this.element;
		if (!element) return this.viewport;

		this.viewport = {
			scrollLeft: element.scrollLeft,
			scrollTop: element.scrollTop,
			viewportWidth: element.clientWidth,
			viewportHeight: element.clientHeight,
		};
		return this.viewport;
	}

	/** Cached viewport without touching the DOM. */
	get cached(): TimelineViewport {
		return this.viewport;
	}

	/** Bucket-aligned viewport, stable across small scroll deltas. */
	get quantizedViewport(): TimelineViewport {
		return this.quantized;
	}

	/**
	 * Notified on every rAF while scrolling. For imperative DOM writers only —
	 * never call `setState` from here.
	 */
	subscribeRaw(listener: () => void): () => void {
		this.rawSubscribers.add(listener);
		return () => this.rawSubscribers.delete(listener);
	}

	/** Notified only when the quantized window changes. Safe for React. */
	subscribeQuantized(listener: () => void): () => void {
		this.quantizedSubscribers.add(listener);
		return () => this.quantizedSubscribers.delete(listener);
	}

	private handleScroll(): void {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(this.flush);
	}

	/** Synchronously re-reads the DOM and notifies. Used on resize/mount. */
	readNow(): void {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.flush();
	}

	private flush(): void {
		this.rafId = null;
		const element = this.element;
		if (!element) return;

		this.viewport = {
			scrollLeft: element.scrollLeft,
			scrollTop: element.scrollTop,
			viewportWidth: element.clientWidth,
			viewportHeight: element.clientHeight,
		};

		for (const listener of this.rawSubscribers) {
			listener();
		}

		this.updateQuantized();
	}

	private updateQuantized(): void {
		const { scrollLeft, scrollTop, viewportWidth, viewportHeight } =
			this.viewport;

		// Snap the window outward so the quantized rect always contains the real
		// one — consumers can render it without gaps at the edges.
		const nextScrollLeft = quantizeDown({ value: scrollLeft });
		const nextScrollTop = quantizeDown({ value: scrollTop });
		const nextWidth = quantizeUp({
			value: viewportWidth + (scrollLeft - nextScrollLeft),
		});
		const nextHeight = quantizeUp({
			value: viewportHeight + (scrollTop - nextScrollTop),
		});

		const previous = this.quantized;
		if (
			previous.scrollLeft === nextScrollLeft &&
			previous.scrollTop === nextScrollTop &&
			previous.viewportWidth === nextWidth &&
			previous.viewportHeight === nextHeight
		) {
			return;
		}

		this.quantized = {
			scrollLeft: nextScrollLeft,
			scrollTop: nextScrollTop,
			viewportWidth: nextWidth,
			viewportHeight: nextHeight,
		};

		for (const listener of this.quantizedSubscribers) {
			listener();
		}
	}
}

export const timelineViewport = new TimelineViewportStore();

/**
 * Intersects a pixel span with the current viewport, expanded by `overscanPx`.
 * Returns null when the span is fully outside.
 */
export function intersectViewportSpan({
	spanLeftPx,
	spanRightPx,
	viewport,
	overscanPx = 0,
}: {
	spanLeftPx: number;
	spanRightPx: number;
	viewport: TimelineViewport;
	overscanPx?: number;
}): { leftPx: number; rightPx: number } | null {
	const windowLeft = viewport.scrollLeft - overscanPx;
	const windowRight =
		viewport.scrollLeft + viewport.viewportWidth + overscanPx;

	const leftPx = Math.max(spanLeftPx, windowLeft);
	const rightPx = Math.min(spanRightPx, windowRight);

	if (rightPx <= leftPx) return null;
	return { leftPx, rightPx };
}

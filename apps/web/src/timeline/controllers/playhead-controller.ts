import type { MouseEvent as ReactMouseEvent } from "react";
import type { FrameRate } from "opencut-wasm";
import {
	mediaTime,
	snapSeekMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
} from "@/timeline/snapping";
import { getBookmarkSnapPoints } from "@/timeline/bookmarks/index";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import {
	getCenteredLineLeft,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import type { Bookmark, SceneTracks } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping";

// --- Session ---

interface ScrubSession {
	kind: "scrubbing";
	/** True when scrub started from a ruler click (not the playhead handle). */
	didStartFromRuler: boolean;
	/** Most recent frame-snapped time set by scrub(). */
	currentTime: MediaTime | null;
	/**
	 * Snap points captured once at gesture start. Rebuilding them per mousemove
	 * walks every element edge, bookmark and keyframe in the scene, which turns
	 * scrubbing into an O(elements) cost per frame. The timeline cannot change
	 * mid-scrub, so a single snapshot is equivalent.
	 */
	snapPoints: SnapPoint[] | null;
}

type Session = { kind: "idle" } | ScrubSession;

// --- Config ---

export interface PlayheadConfig {
	zoomLevel: number;
	duration: MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	isShiftHeld: () => boolean;
	getIsPlaying: () => boolean;
	getRulerEl: () => HTMLDivElement | null;
	getRulerScrollEl: () => HTMLDivElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getPlayheadEl: () => HTMLDivElement | null;
	getSceneTracks: () => SceneTracks;
	getSceneBookmarks: () => Bookmark[];
	seek: (time: MediaTime) => void;
	setScrubbing: (isScrubbing: boolean) => void;
	setTimelineViewState: (viewState: {
		zoomLevel: number;
		scrollLeft: number;
		playheadTime: MediaTime;
	}) => void;
}

export interface PlayheadConfigRef {
	readonly current: PlayheadConfig;
}

// --- Pure helpers (px → logical) ---

function pixelToTime({
	clientX,
	rulerEl,
	zoomLevel,
	duration,
}: {
	clientX: number;
	rulerEl: HTMLDivElement;
	zoomLevel: number;
	duration: MediaTime;
}): MediaTime {
	const rulerRect = rulerEl.getBoundingClientRect();
	const contentWidth = timelineTimeToPixels({ time: duration, zoomLevel });
	const clampedX = Math.max(
		0,
		Math.min(contentWidth, clientX - rulerRect.left),
	);
	const seconds = Math.max(
		0,
		Math.min(
			duration / TICKS_PER_SECOND,
			clampedX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel),
		),
	);
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

// --- Controller ---

export class PlayheadController {
	private lastMouseClientX = 0;

	private session: Session = { kind: "idle" };
	private readonly configRef: PlayheadConfigRef;

	constructor(deps: { configRef: PlayheadConfigRef }) {
		this.configRef = deps.configRef;
		this.onPlayheadMouseDown = this.onPlayheadMouseDown.bind(this);
		this.onRulerMouseDown = this.onRulerMouseDown.bind(this);
		this.handleMouseMove = this.handleMouseMove.bind(this);
		this.handleMouseUp = this.handleMouseUp.bind(this);
	}

	private get config(): PlayheadConfig {
		return this.configRef.current;
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	getLastMouseClientX(): number {
		return this.lastMouseClientX;
	}

	destroy(): void {
		this.deactivate();
	}

	// --- Public event handlers (bound, stable references) ---

	onPlayheadMouseDown(event: ReactMouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.session = {
			kind: "scrubbing",
			didStartFromRuler: false,
			currentTime: null,
			snapPoints: this.buildSnapPoints(),
		};
		this.config.setScrubbing(true);
		this.scrub({ event, isElementSnappingEnabled: true });
		this.activate();
	}

	onRulerMouseDown(event: ReactMouseEvent): void {
		if (event.button !== 0) return;
		const target = event.target;
		if (target instanceof Node && this.config.getPlayheadEl()?.contains(target)) {
			return;
		}

		event.preventDefault();
		this.session = {
			kind: "scrubbing",
			didStartFromRuler: true,
			currentTime: null,
			snapPoints: this.buildSnapPoints(),
		};
		this.config.setScrubbing(true);
		// No element-edge snapping on initial ruler click — avoids a jarring jump.
		this.scrub({ event, isElementSnappingEnabled: false });
		this.activate();
	}

	// --- Public non-session methods ---

	/**
	 * Imperatively updates the playhead DOM element's `left` style.
	 * Called on scroll and playback events to avoid React re-renders
	 * during animation frame updates.
	 */
	updatePlayheadLeft(time: MediaTime): void {
		const playheadEl = this.config.getPlayheadEl();
		if (!playheadEl) return;

		const centerPixel = timelineTimeToSnappedPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		// The tracks area is the element the user actually scrolls; the ruler is a
		// follower that is synced from it, so reading tracks avoids a one-frame
		// stale offset when both are updated in the same tick.
		const scrollLeft =
			this.config.getTracksScrollEl()?.scrollLeft ??
			this.config.getRulerScrollEl()?.scrollLeft ??
			0;
		playheadEl.style.left = `${getCenteredLineLeft({ centerPixel }) - scrollLeft}px`;
	}

	/** Repositions the playhead against the current playback time. */
	syncToCurrentTime(time: MediaTime): void {
		this.updatePlayheadLeft(time);
	}

	/**
	 * Updates the playhead position and auto-scrolls to keep the playhead
	 * visible during playback.
	 */
	handlePlaybackUpdate(time: MediaTime): void {
		this.updatePlayheadLeft(time);

		// Auto-scroll only during playback, not while scrubbing.
		if (!this.config.getIsPlaying() || this.session.kind === "scrubbing")
			return;

		const rulerViewport = this.config.getRulerScrollEl();
		const tracksViewport = this.config.getTracksScrollEl();
		if (!rulerViewport || !tracksViewport) return;

		const playheadPixels = timelineTimeToPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		const viewportWidth = rulerViewport.clientWidth;
		const isOutOfView =
			playheadPixels < rulerViewport.scrollLeft ||
			playheadPixels > rulerViewport.scrollLeft + viewportWidth;

		if (isOutOfView) {
			const desiredScroll = Math.max(
				0,
				Math.min(
					rulerViewport.scrollWidth - viewportWidth,
					playheadPixels - viewportWidth / 2,
				),
			);
			rulerViewport.scrollLeft = tracksViewport.scrollLeft = desiredScroll;
		}
	}

	// --- Private ---

	private activate(): void {
		window.addEventListener("mousemove", this.handleMouseMove);
		window.addEventListener("mouseup", this.handleMouseUp);
	}

	private deactivate(): void {
		window.removeEventListener("mousemove", this.handleMouseMove);
		window.removeEventListener("mouseup", this.handleMouseUp);
	}

	private buildSnapPoints(): SnapPoint[] {
		return buildTimelineSnapPoints({
			sources: [
				() => getElementEdgeSnapPoints({ tracks: this.config.getSceneTracks() }),
				() =>
					getBookmarkSnapPoints({
						bookmarks: this.config.getSceneBookmarks(),
					}),
				() =>
					getAnimationKeyframeSnapPointsForTimeline({
						tracks: this.config.getSceneTracks(),
					}),
			],
		});
	}

	/**
	 * Converts pointer position to a frame-snapped timeline time and seeks.
	 * `isElementSnappingEnabled` controls element-edge snapping; frame-level snapping
	 * is always applied.
	 */
	private scrub({
		event,
		isElementSnappingEnabled,
	}: {
		event: MouseEvent | ReactMouseEvent;
		isElementSnappingEnabled: boolean;
	}): void {
		const ruler = this.config.getRulerEl();
		if (!ruler) return;

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		const { zoomLevel, duration } = this.config;
		const rawTime = pixelToTime({
			clientX: event.clientX,
			rulerEl: ruler,
			zoomLevel,
			duration,
		});
		const frameTime = snapSeekMediaTime({ time: rawTime, duration, fps });

		const time = (() => {
			if (!isElementSnappingEnabled || this.config.isShiftHeld())
				return frameTime;

			const snapPoints =
				this.session.kind === "scrubbing" && this.session.snapPoints
					? this.session.snapPoints
					: this.buildSnapPoints();
			const result = resolveTimelineSnap({
				targetTime: frameTime,
				snapPoints,
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});
			return result.snapPoint ? result.snappedTime : frameTime;
		})();

		if (this.session.kind === "scrubbing") {
			this.session.currentTime = time;
		}
		this.config.seek(time);
		this.lastMouseClientX = event.clientX;
	}

	private handleMouseMove(event: MouseEvent): void {
		if (this.session.kind !== "scrubbing") return;
		this.scrub({ event, isElementSnappingEnabled: true });
	}

	private handleMouseUp(event: MouseEvent): void {
		if (this.session.kind !== "scrubbing") return;

		const session = this.session;
		this.config.setScrubbing(false);

		// Keep the release-position behavior without issuing a duplicate seek when
		// the pointer did not move after the latest mousedown/mousemove.
		if (
			session.didStartFromRuler &&
			event.clientX !== this.lastMouseClientX
		) {
			this.scrub({ event, isElementSnappingEnabled: false });
		}

		if (session.currentTime !== null) {
			this.config.setTimelineViewState({
				zoomLevel: this.config.zoomLevel,
				scrollLeft: this.config.getTracksScrollEl()?.scrollLeft ?? 0,
				playheadTime: session.currentTime,
			});
		}

		this.session = { kind: "idle" };
		this.deactivate();
	}
}

import type { MouseEvent as ReactMouseEvent } from "react";
import type { FrameRate } from "opencut-wasm";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { mediaTime, snapSeekMediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";

type SeekSource = "ruler" | "tracks";

interface PendingSeekSession {
	kind: "pending";
	source: SeekSource;
	downX: number;
	downY: number;
	downTime: number;
	/** Playhead time before the mousedown seek, used to undo the seek when the
	 *  gesture turns out to be a drag (e.g. box-select) rather than a click. */
	previousTime: MediaTime | null;
	restored: boolean;
}

type Session = { kind: "idle" } | PendingSeekSession;

export interface SeekConfig {
	zoomLevel: number;
	duration: MediaTime;
	isSelecting: boolean;
	getPlayheadEl: () => HTMLDivElement | null;
	getTrackLabelsEl: () => HTMLDivElement | null;
	getRulerScrollEl: () => HTMLDivElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getActiveProjectFps: () => FrameRate | null;
	getCurrentTime: () => MediaTime;
	clearSelectedElements: () => void;
	seek: (time: MediaTime) => void;
	setTimelineViewState: (viewState: {
		zoomLevel: number;
		scrollLeft: number;
		playheadTime: MediaTime;
	}) => void;
}

export interface SeekConfigRef {
	readonly current: SeekConfig;
}

function pixelToTime({
	clientX,
	scrollContainer,
	zoomLevel,
	duration,
}: {
	clientX: number;
	scrollContainer: HTMLDivElement;
	zoomLevel: number;
	duration: MediaTime;
}): MediaTime {
	const rect = scrollContainer.getBoundingClientRect();
	const mouseX = clientX - rect.left;
	const scrollLeft = scrollContainer.scrollLeft;

	const rawTimeSeconds = Math.max(
		0,
		Math.min(
			duration / TICKS_PER_SECOND,
			(mouseX + scrollLeft) / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel),
		),
	);

	return mediaTime({ ticks: Math.round(rawTimeSeconds * TICKS_PER_SECOND) });
}

function isClickGesture({
	event,
	session,
}: {
	event: ReactMouseEvent;
	session: PendingSeekSession;
}): boolean {
	const deltaX = Math.abs(event.clientX - session.downX);
	const deltaY = Math.abs(event.clientY - session.downY);
	const deltaTime = event.timeStamp - session.downTime;

	return deltaX <= 5 && deltaY <= 5 && deltaTime <= 500;
}

export class SeekController {
	private session: Session = { kind: "idle" };
	private readonly configRef: SeekConfigRef;

	constructor(deps: { configRef: SeekConfigRef }) {
		this.configRef = deps.configRef;
		this.onTracksMouseDown = this.onTracksMouseDown.bind(this);
		this.onRulerMouseDown = this.onRulerMouseDown.bind(this);
		this.onTracksClick = this.onTracksClick.bind(this);
		this.onRulerClick = this.onRulerClick.bind(this);
	}

	private get config(): SeekConfig {
		return this.configRef.current;
	}

	destroy(): void {
		this.disarmDragRestore();
		this.session = { kind: "idle" };
	}

	onTracksMouseDown(event: ReactMouseEvent): void {
		this.beginPendingSeek({ event, source: "tracks" });

		// Seek on mousedown, same as the ruler's playhead scrub. Deferring to
		// click/mouseup silently drops the seek whenever the gesture is not
		// recognized as a click (pointer released over a different element,
		// moved >5px, or held >500ms) — the user sees "no response".
		// If the gesture turns out to be a drag (box-select), the playhead is
		// restored — see handleDragRestoreMouseMove.
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (this.config.getPlayheadEl()?.contains(target)) return;
		if (this.session.kind === "pending") {
			this.session.previousTime = this.config.getCurrentTime();
		}
		this.seekFromEvent({ event, source: "tracks" });
		this.armDragRestore();
	}

	onRulerMouseDown(event: ReactMouseEvent): void {
		this.beginPendingSeek({ event, source: "ruler" });
	}

	onTracksClick(event: ReactMouseEvent): void {
		this.handleClick({ event, source: "tracks" });
	}

	onRulerClick(event: ReactMouseEvent): void {
		this.handleClick({ event, source: "ruler" });
	}

	private beginPendingSeek({
		event,
		source,
	}: {
		event: ReactMouseEvent;
		source: SeekSource;
	}): void {
		if (event.button !== 0) return;

		this.disarmDragRestore();
		this.session = {
			kind: "pending",
			source,
			downX: event.clientX,
			downY: event.clientY,
			downTime: event.timeStamp,
			previousTime: null,
			restored: false,
		};
	}

	// Box-select on empty track space shares the mousedown that triggered the
	// seek above; once the pointer moves past the click threshold the gesture
	// is a drag, so put the playhead back where it was.
	private handleDragRestoreMouseMove = (event: MouseEvent): void => {
		if (this.session.kind !== "pending" || this.session.source !== "tracks") {
			return;
		}
		const deltaX = Math.abs(event.clientX - this.session.downX);
		const deltaY = Math.abs(event.clientY - this.session.downY);
		if (deltaX <= 5 && deltaY <= 5) return;

		this.restorePlayhead({ session: this.session });
		this.disarmDragRestore();
	};

	private handleDragRestoreMouseUp = (): void => {
		this.disarmDragRestore();
	};

	private restorePlayhead({ session }: { session: PendingSeekSession }): void {
		if (session.restored || session.previousTime === null) return;
		session.restored = true;

		const previousTime = session.previousTime;
		this.config.seek(previousTime);
		this.config.setTimelineViewState({
			zoomLevel: this.config.zoomLevel,
			scrollLeft: this.config.getTracksScrollEl()?.scrollLeft ?? 0,
			playheadTime: previousTime,
		});
	}

	private armDragRestore(): void {
		document.addEventListener("mousemove", this.handleDragRestoreMouseMove);
		document.addEventListener("mouseup", this.handleDragRestoreMouseUp);
	}

	private disarmDragRestore(): void {
		document.removeEventListener("mousemove", this.handleDragRestoreMouseMove);
		document.removeEventListener("mouseup", this.handleDragRestoreMouseUp);
	}

	private handleClick({
		event,
		source,
	}: {
		event: ReactMouseEvent;
		source: SeekSource;
	}): void {
		const shouldProcess = this.shouldProcessClick({ event, source });
		this.session = { kind: "idle" };

		if (!shouldProcess) return;

		this.config.clearSelectedElements();
		this.seekFromEvent({ event, source });
	}

	private shouldProcessClick({
		event,
		source,
	}: {
		event: ReactMouseEvent;
		source: SeekSource;
	}): boolean {
		if (this.session.kind !== "pending") return false;
		if (this.session.source !== source) return false;
		if (!isClickGesture({ event, session: this.session })) return false;
		if (this.config.isSelecting) return false;

		const target = event.target as HTMLElement;
		if (this.config.getPlayheadEl()?.contains(target)) return false;

		if (this.config.getTrackLabelsEl()?.contains(target)) {
			this.config.clearSelectedElements();
			return false;
		}

		return true;
	}

	private seekFromEvent({
		event,
		source,
	}: {
		event: ReactMouseEvent;
		source: SeekSource;
	}): void {
		const scrollContainer =
			source === "ruler"
				? this.config.getRulerScrollEl()
				: this.config.getTracksScrollEl();
		if (!scrollContainer) return;

		const rawTime = pixelToTime({
			clientX: event.clientX,
			scrollContainer,
			zoomLevel: this.config.zoomLevel,
			duration: this.config.duration,
		});

		const fps = this.config.getActiveProjectFps();
		const time =
			fps != null
				? snapSeekMediaTime({
						time: rawTime,
						duration: this.config.duration,
						fps,
					})
				: rawTime;

		// Track clicks seek on mousedown and again on click; ruler clicks scrub on
		// mousedown and land here on click. Re-seeking to the frame we're already
		// on is not free — every seek bumps the preview's seek revision and costs
		// a full extra render — so skip it.
		if (time === this.config.getCurrentTime()) return;

		this.config.seek(time);
		this.config.setTimelineViewState({
			zoomLevel: this.config.zoomLevel,
			scrollLeft: scrollContainer.scrollLeft,
			playheadTime: time,
		});
	}
}

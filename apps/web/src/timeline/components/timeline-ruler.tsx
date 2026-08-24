import { type JSX } from "react";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { TIMELINE_RULER_HEIGHT_PX } from "./layout";
import { DEFAULT_FPS } from "@/fps/defaults";
import { useEditor } from "@/editor/use-editor";
import { getRulerConfig, shouldShowLabel } from "@/timeline/ruler-utils";
import { useQuantizedTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";
import { TimelineTick } from "./timeline-tick";

/**
 * Fixed overscan in pixels. This used to be a fraction of `scrollLeft`, which
 * meant the buffer — and therefore the number of rendered ticks — grew without
 * bound as you scrolled into a long timeline. A constant keeps tick count a
 * function of viewport width only.
 */
const RULER_OVERSCAN_PX = 400;

interface TimelineRulerProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	rulerRef: React.Ref<HTMLDivElement>;
	handleWheel: (e: React.WheelEvent) => void;
	handleTimelineContentClick: (e: React.MouseEvent) => void;
	handleRulerTrackingMouseDown: (e: React.MouseEvent) => void;
	handleRulerMouseDown: (e: React.MouseEvent) => void;
}

export function TimelineRuler({
	zoomLevel,
	dynamicTimelineWidth,
	rulerRef,
	handleWheel,
	handleTimelineContentClick,
	handleRulerTrackingMouseDown,
	handleRulerMouseDown,
}: TimelineRulerProps) {
	const durationTicks = useEditor((e) => e.timeline.getTotalDuration());
	const durationSeconds = mediaTimeToSeconds({ time: durationTicks });
	const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
	const visibleDurationSeconds = dynamicTimelineWidth / pixelsPerSecond;
	const effectiveDurationSeconds = Math.max(
		durationSeconds,
		visibleDurationSeconds,
	);
	const fps =
		useEditor((e) => e.project.getActiveOrNull()?.settings.fps) ?? DEFAULT_FPS;
	const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig({
		zoomLevel,
		fps,
	});
	const tickCount =
		Math.ceil(effectiveDurationSeconds / tickIntervalSeconds) + 1;

	const { scrollLeft, viewportWidth } = useQuantizedTimelineViewport();

	const visibleStartTimeSeconds = Math.max(
		0,
		(scrollLeft - RULER_OVERSCAN_PX) / pixelsPerSecond,
	);
	const visibleEndTimeSeconds =
		(scrollLeft + viewportWidth + RULER_OVERSCAN_PX) / pixelsPerSecond;

	const startTickIndex = Math.max(
		0,
		Math.floor(visibleStartTimeSeconds / tickIntervalSeconds),
	);
	const endTickIndex = Math.min(
		tickCount - 1,
		Math.ceil(visibleEndTimeSeconds / tickIntervalSeconds),
	);

	const timelineTicks: Array<JSX.Element> = [];
	for (
		let tickIndex = startTickIndex;
		tickIndex <= endTickIndex;
		tickIndex += 1
	) {
		const timeSeconds = tickIndex * tickIntervalSeconds;
		if (timeSeconds > effectiveDurationSeconds) break;

		const timeTicks = Math.round(timeSeconds * TICKS_PER_SECOND);
		const showLabel = shouldShowLabel({
			time: timeSeconds,
			labelIntervalSeconds,
		});
		timelineTicks.push(
			<TimelineTick
				key={tickIndex}
				time={timeTicks}
				timeInSeconds={timeSeconds}
				zoomLevel={zoomLevel}
				fps={fps}
				showLabel={showLabel}
			/>,
		);
	}

	return (
		<div
			role="slider"
			tabIndex={0}
			aria-label="Timeline ruler"
			aria-valuemin={0}
			aria-valuemax={effectiveDurationSeconds}
			aria-valuenow={0}
			className="relative flex-1 overflow-x-visible"
			style={{ height: TIMELINE_RULER_HEIGHT_PX }}
			onWheel={handleWheel}
			onClick={(event) => {
				// Ruler seek already happens on mousedown via playhead scrubbing.
				// Forwarding the follow-up click re-enters the selection-clearing path.
				if (event.target === event.currentTarget) {
					handleTimelineContentClick(event);
				}
			}}
			onMouseDown={handleRulerTrackingMouseDown}
			onKeyDown={() => {}}
		>
			<div
				role="none"
				ref={rulerRef}
				className="relative cursor-default select-none"
				style={{
					height: TIMELINE_RULER_HEIGHT_PX,
					width: `${dynamicTimelineWidth}px`,
				}}
				onMouseDown={handleRulerMouseDown}
			>
				{timelineTicks}
			</div>
		</div>
	);
}

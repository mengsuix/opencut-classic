"use client";

import { useContainerSize } from "@/hooks/use-container-size";
import { TIMELINE_INDICATOR_LINE_WIDTH_PX } from "@/timeline";
import {
	addMediaTime,
	maxMediaTime,
	mediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { useEditor } from "@/editor/use-editor";
import { TIMELINE_SCROLLBAR_SIZE_PX } from "./layout";
import { TIMELINE_LAYERS } from "./layers";
import { useT } from "@/i18n";

interface TimelinePlayheadProps {
	hasHorizontalScrollbar: boolean;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineRef: React.RefObject<HTMLDivElement | null>;
	playheadRef: React.RefObject<HTMLDivElement | null>;
	onPlayheadMouseDown: (event: React.MouseEvent) => void;
	isSnappingToPlayhead?: boolean;
}

/**
 * Renders the playhead shell only. Its horizontal position is owned entirely by
 * `PlayheadController`, which writes `style.left` imperatively on scroll and
 * playback ticks. Deriving `left` from React state here as well would fight the
 * controller: React commits land a frame later with a staler scroll offset,
 * which is what made the line visibly lag behind the cursor.
 */
export function TimelinePlayhead({
	hasHorizontalScrollbar,
	tracksScrollRef,
	timelineRef,
	playheadRef,
	onPlayheadMouseDown,
	isSnappingToPlayhead = false,
}: TimelinePlayheadProps) {
	const t = useT();
	const editor = useEditor();
	const duration = editor.timeline.getTotalDuration();
	const { height: timelineHeight } = useContainerSize({
		containerRef: timelineRef,
	});
	const { height: tracksHeight } = useContainerSize({
		containerRef: tracksScrollRef,
	});

	const timelineContainerHeight = timelineHeight || tracksHeight || 400;
	const totalHeight = Math.max(
		0,
		timelineContainerHeight -
			(hasHorizontalScrollbar ? TIMELINE_SCROLLBAR_SIZE_PX - 5 : 0),
	);

	const currentTime = editor.playback.getCurrentTime();

	const handlePlayheadKeyDown = (
		event: React.KeyboardEvent<HTMLDivElement>,
	) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

		event.preventDefault();
		const fps = editor.project.getActive().settings.fps;
		const ticksPerFrame = mediaTime({
			ticks: Math.round(
				(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
			),
		});
		const direction = event.key === "ArrowRight" ? 1 : -1;
		const now = editor.playback.getCurrentTime();
		const nextTime =
			direction > 0
				? addMediaTime({ a: now, b: ticksPerFrame })
				: subMediaTime({ a: now, b: ticksPerFrame });

		editor.playback.seek({
			time: maxMediaTime({
				a: ZERO_MEDIA_TIME,
				b: duration < nextTime ? duration : nextTime,
			}),
		});
	};

	return (
		<div
			ref={playheadRef}
			role="slider"
			aria-label={t("timeline.timelinePlayhead")}
			aria-valuemin={0}
			aria-valuemax={duration}
			aria-valuenow={currentTime}
			tabIndex={0}
			className="pointer-events-none absolute"
			style={{
				top: 0,
				height: `${totalHeight}px`,
				width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
				zIndex: TIMELINE_LAYERS.playhead,
			}}
			onKeyDown={handlePlayheadKeyDown}
		>
			<div className="bg-primary pointer-events-none absolute left-0 h-full w-0.5" />

			<button
				type="button"
				aria-label={t("timeline.dragPlayhead")}
				className={`pointer-events-auto absolute top-1 left-1/2 size-3 -translate-x-1/2 transform cursor-col-resize rounded-full border-2 shadow-xs ${isSnappingToPlayhead ? "bg-primary border-primary" : "bg-primary border-primary/50"}`}
				onMouseDown={onPlayheadMouseDown}
			/>
		</div>
	);
}

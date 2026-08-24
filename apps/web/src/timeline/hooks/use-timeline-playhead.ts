import { useEffect, useLayoutEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useEdgeAutoScroll } from "@/timeline/hooks/use-edge-auto-scroll";
import { timelineTimeToPixels } from "@/timeline";
import {
	PlayheadController,
	type PlayheadConfig,
} from "@/timeline/controllers/playhead-controller";
import { timelineViewport } from "@/timeline/viewport-store";
import type { MediaTime } from "@/wasm";

interface UseTimelinePlayheadProps {
	zoomLevel: number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	playheadRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * Owns the single PlayheadController for the timeline.
 *
 * Must be called exactly once per timeline. It used to be called both by the
 * Timeline container and by TimelinePlayhead, which produced two controllers,
 * two scroll listeners, two playback subscriptions and two writers racing on the
 * same `style.left`.
 */
export function useTimelinePlayhead({
	zoomLevel,
	rulerRef,
	rulerScrollRef,
	tracksScrollRef,
	playheadRef,
}: UseTimelinePlayheadProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	// isScrubbing drives useEdgeAutoScroll — the controller sets it on the editor,
	// so this reactive read naturally reflects whether scrubbing is active.
	const isScrubbing = useEditor((e) => e.playback.getIsScrubbing());

	const config: PlayheadConfig = {
		zoomLevel,
		duration: editor.timeline.getTotalDuration(),
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		isShiftHeld: () => isShiftHeldRef.current,
		getIsPlaying: () => editor.playback.getIsPlaying(),
		getRulerEl: () => rulerRef.current,
		getRulerScrollEl: () => rulerScrollRef.current,
		getTracksScrollEl: () => tracksScrollRef.current,
		getPlayheadEl: () => playheadRef?.current ?? null,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getSceneBookmarks: () => editor.scenes.getActiveScene()?.bookmarks ?? [],
		seek: (time) => editor.playback.seek({ time }),
		setScrubbing: (scrubbing) =>
			editor.playback.setScrubbing({ isScrubbing: scrubbing }),
		setTimelineViewState: ({ zoomLevel, scrollLeft, playheadTime }) =>
			editor.project.setTimelineViewState({
				viewState: {
					zoomLevel,
					scrollLeft,
					playheadTime,
				},
			}),
	};
	const configRef = useCommittedRef(config);
	const [ctrl] = useState(() => new PlayheadController({ configRef }));

	// Scroll → reposition imperatively, batched to one write per frame by the
	// shared viewport store. No React state is involved.
	useEffect(() => {
		const reposition = () =>
			ctrl.updatePlayheadLeft(editor.playback.getCurrentTime());
		reposition();
		return timelineViewport.subscribeRaw(reposition);
	}, [ctrl, editor.playback]);

	// Playback events → update playhead position and auto-scroll during playback.
	useEffect(() => {
		const handler = (time: MediaTime) => ctrl.handlePlaybackUpdate(time);
		ctrl.updatePlayheadLeft(editor.playback.getCurrentTime());
		const unsubscribeUpdate = editor.playback.onUpdate(handler);
		const unsubscribeSeek = editor.playback.onSeek(handler);
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
		};
	}, [ctrl, editor.playback]);

	// Zoom changes the time→pixel mapping without emitting scroll or playback
	// events, so the position has to be recomputed after that layout pass.
	useLayoutEffect(() => {
		ctrl.syncToCurrentTime(editor.playback.getCurrentTime());
	}, [ctrl, editor.playback, zoomLevel]);

	useEdgeAutoScroll({
		isActive: isScrubbing,
		getMouseClientX: () => ctrl.getLastMouseClientX(),
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: timelineTimeToPixels({
			time: editor.timeline.getTotalDuration(),
			zoomLevel,
		}),
	});

	useEffect(() => () => ctrl.destroy(), [ctrl]);

	return {
		handlePlayheadMouseDown: ctrl.onPlayheadMouseDown,
		handleRulerMouseDown: ctrl.onRulerMouseDown,
	};
}

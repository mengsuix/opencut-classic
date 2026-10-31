"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete02Icon,
	Link02Icon,
	LockIcon,
	MoreHorizontalIcon,
	TaskAdd02Icon,
	Unlink02Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTimelineZoom } from "@/timeline/hooks/use-timeline-zoom";
import {
	memo,
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { useContainerSize } from "@/hooks/use-container-size";
import type { MediaTime } from "@/wasm";
import type { ElementDragView, DropTarget } from "@/timeline";
import { TimelineLiveZoomContext, TimelineTrackContent } from "./timeline-track";
import { TimelinePlayhead } from "./timeline-playhead";
import { SelectionBox } from "@/selection/selection-box";
import { useBoxSelect } from "@/selection/hooks/use-box-select";
import { SnapIndicator } from "./snap-indicator";
import type { SnapPoint } from "@/timeline/snapping";
import type { TimelineTrack } from "@/timeline";
import {
	TIMELINE_SCROLLBAR_SIZE_PX,
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
	KEYFRAME_LANE_HEIGHT_PX,
} from "./layout";
import { useElementInteraction } from "@/timeline/hooks/element/use-element-interaction";
import {
	canTrackHaveAudio,
	canTrackBeHidden,
	getTimelineZoomMin,
	getTimelineZoomMax,
	getTimelinePaddingPx,
} from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { getTrackHeight, getTrackOffsets } from "./track-layout";
import { SELECTED_TRACK_ROW_CLASS } from "./theme";
import {
	computeTrackExpansionHeight,
	getTrackExpandedRows,
	getPropertyLabel,
	type ExpandedRow,
} from "./expanded-layout";
import { TIMELINE_HORIZONTAL_WHEEL_STEP_PX } from "./interaction";
import { TimelineToolbar, ADDABLE_TRACK_TYPES } from "./timeline-toolbar";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { useTimelineSeek } from "@/timeline/hooks/use-timeline-seek";
import { useTimelineDragDrop } from "@/timeline/hooks/use-timeline-drag-drop";
import { TimelineRuler } from "./timeline-ruler";
import { TimeRangeOverlay } from "./time-range-overlay";
import {
	TimelineBookmarksRow,
	useBookmarkDrag,
} from "@/timeline/bookmarks/index";
import { useEdgeAutoScroll } from "@/timeline/hooks/use-edge-auto-scroll";
import { useInitialScrollBottom } from "@/timeline/hooks/use-initial-scroll-bottom";
import { useTimelineResize } from "@/timeline/hooks/use-timeline-resize";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditor } from "@/editor/use-editor";
import {
	useBindTimelineViewport,
	useTimelineViewportWidth,
} from "@/timeline/hooks/use-timeline-viewport";
import { timelineViewport } from "@/timeline/viewport-store";
import {
	usePlayheadScrubAutoScroll,
	useTimelinePlayhead,
} from "@/timeline/hooks/use-timeline-playhead";
import { useTimelineRangeSelect } from "@/timeline/hooks/use-timeline-range-select";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { DragLine } from "./drag-line";
import { invokeAction } from "@/actions";
import type { ClipboardEntry } from "@/clipboard";
import { resolveTimelineElementIntersections } from "./selection-hit-testing";
import { cn } from "@/utils/ui";
import { useT, useLocale } from "@/i18n";

const TRACKS_CONTAINER_MAX_HEIGHT = 800;

const FALLBACK_CONTAINER_WIDTH = 1000;
const TRACKS_CONTAINER_HEIGHT = { min: 0, max: TRACKS_CONTAINER_MAX_HEIGHT };
function useClipboardHasEntry(): boolean {
	const editor = useEditor();
	const subscribe = useCallback(
		(callback: () => void) => editor.clipboard.subscribe(callback),
		[editor],
	);
	return useSyncExternalStore(subscribe, () => editor.clipboard.hasEntry());
}

function useClipboardEntry(): ClipboardEntry | null {
	const editor = useEditor();
	const subscribe = useCallback(
		(callback: () => void) => editor.clipboard.subscribe(callback),
		[editor],
	);
	return useSyncExternalStore(subscribe, () => editor.clipboard.getEntry());
}

/** Element clipboard items can only land on a track of the same type;
 * keyframe entries don't support track-targeted paste. */
function canPasteEntryOnTrack({
	entry,
	track,
}: {
	entry: ClipboardEntry | null;
	track: TimelineTrack;
}): boolean {
	return (
		entry?.type === "elements" &&
		entry.items.length > 0 &&
		entry.items.every((item) => item.trackType === track.type)
	);
}

export function Timeline() {
	const t = useT();
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const {
		selectedElements,
		clearElementSelection,
		setElementSelection,
		mergeElementsIntoSelection,
	} = useElementSelection();
	const editor = useEditor();
	const timeline = editor.timeline;
	const scene = useEditor((currentEditor) =>
		currentEditor.scenes.getActiveSceneOrNull(),
	);
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const mainTrackId = scene?.tracks.main.id ?? null;
	const lockedTrackIds = useMemo(
		() =>
			new Set(tracks.filter((track) => track.locked).map((track) => track.id)),
		[tracks],
	);
	const seek = (time: MediaTime) => editor.playback.seek({ time });

	const timelineRef = useRef<HTMLDivElement>(null);
	const timelineHeaderRef = useRef<HTMLDivElement>(null);
	const rulerRef = useRef<HTMLDivElement>(null);
	const rulerScrollRef = useRef<HTMLDivElement>(null);
	const tracksContainerRef = useRef<HTMLDivElement>(null);
	const tracksScrollRef = useRef<HTMLDivElement>(null);
	const trackLabelsRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	const trackLabelsScrollRef = useRef<HTMLDivElement>(null);

	const [currentSnapPoint, setCurrentSnapPoint] = useState<SnapPoint | null>(
		null,
	);
	const [highlightedTrackId, setHighlightedTrackId] = useState<string | null>(
		null,
	);
	const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	useEffect(
		() => () => {
			if (highlightTimeoutRef.current) {
				clearTimeout(highlightTimeoutRef.current);
			}
		},
		[],
	);
	const { width: tracksContainerWidth } = useContainerSize({
		containerRef: tracksContainerRef,
	});
	const { height: timelineHeaderHeightValue } = useContainerSize({
		containerRef: timelineHeaderRef,
	});

	// Single rAF-batched source of truth for scroll offset / viewport size. Every
	// consumer reads from here instead of attaching its own scroll listener.
	useBindTimelineViewport({ scrollRef: tracksScrollRef });
	// Width only: subscribing to the quantized window here re-rendered the whole
	// timeline every time a scroll crossed a 256px bucket (playback auto-scroll,
	// panning). The windowed children subscribe to it themselves.
	const tracksViewportWidth = useTimelineViewportWidth();

	const handleSnapPointChange = useCallback((snapPoint: SnapPoint | null) => {
		setCurrentSnapPoint(snapPoint);
	}, []);

	const timelineDuration = timeline.getTotalDuration() || 0;
	const containerWidth = tracksContainerWidth || FALLBACK_CONTAINER_WIDTH;
	const minZoomLevel = getTimelineZoomMin({
		duration: timelineDuration,
		containerWidth,
	});
	// Caps the timeline's DOM width. Longer media trades maximum magnification for
	// interaction cost that stays independent of duration.
	const maxZoomLevel = getTimelineZoomMax({ duration: timelineDuration });

	const savedViewState = editor.project.getTimelineViewState();

	const { zoomLevel, setZoomLevel, saveScrollPosition } = useTimelineZoom({
		containerRef: timelineRef,
		minZoom: minZoomLevel,
		maxZoom: maxZoomLevel,
		initialZoom: savedViewState?.zoomLevel,
		initialScrollLeft: savedViewState?.scrollLeft,
		initialPlayheadTime: savedViewState?.playheadTime,
		tracksScrollRef,
		rulerScrollRef,
	});
	// Clips are laid out at a *deferred* zoom. During a zoom gesture the urgent
	// render only touches the ruler, content width and per-track windowing; each
	// track's clip layer is stretched by `scaleX(live / deferred)` (see
	// TimelineTrackContent) so clips stay aligned with the ruler, and the full
	// clip re-layout runs as an interruptible background render once the
	// gesture settles. Re-laying out every clip synchronously on each wheel
	// frame cost 80–150ms per step.
	const deferredZoomLevel = useDeferredValue(zoomLevel);
	const { isResizing, handleResizeStart } = useTimelineResize({
		zoomLevel,
		onSnapPointChange: handleSnapPointChange,
	});

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	// Prefix sums; deriving each track's offset independently is O(n²).
	const trackLayout = useMemo(
		() =>
			getTrackOffsets({
				tracks,
				getExtraHeight: getTrackExpansionHeight,
			}),
		[tracks, getTrackExpansionHeight],
	);

	// Stable refs so the wheel listener never goes stale
	const setZoomLevelRef = useRef(setZoomLevel);
	useEffect(() => {
		setZoomLevelRef.current = setZoomLevel;
	}, [setZoomLevel]);

	const saveScrollPositionRef = useRef(saveScrollPosition);
	useEffect(() => {
		saveScrollPositionRef.current = saveScrollPosition;
	}, [saveScrollPosition]);

	const minZoomLevelRef = useRef(minZoomLevel);
	useEffect(() => {
		minZoomLevelRef.current = minZoomLevel;
	}, [minZoomLevel]);

	// Pushes tracks scroll position to the two overflow:hidden followers
	// (ruler and track labels). Called from the wheel handler (before paint,
	// zero lag) and from onScroll on the tracks area (covers scrollbar drag).
	const syncFollowers = useCallback(() => {
		const tracks = tracksScrollRef.current;
		if (!tracks) return;
		if (rulerScrollRef.current) {
			rulerScrollRef.current.scrollLeft = tracks.scrollLeft;
		}
		if (trackLabelsScrollRef.current) {
			trackLabelsScrollRef.current.scrollTop = tracks.scrollTop;
		}
	}, []);

	// A newly added track can land below the fold (audio tracks append at the
	// bottom), making "add track" look like a no-op. Scroll it into view. The
	// pending id sits in a ref; the tracks change caused by addTrack re-runs
	// the effect, which then does the scrolling.
	const pendingRevealTrackIdRef = useRef<string | null>(null);
	const handleAddTrack = useCallback(
		(type: (typeof ADDABLE_TRACK_TYPES)[number]["type"]) => {
			pendingRevealTrackIdRef.current = editor.timeline.addTrack({ type });
		},
		[editor],
	);
	useEffect(() => {
		const trackId = pendingRevealTrackIdRef.current;
		if (!trackId) return;
		pendingRevealTrackIdRef.current = null;
		const scrollEl = tracksScrollRef.current;
		const trackIndex = tracks.findIndex((track) => track.id === trackId);
		if (!scrollEl || trackIndex < 0) return;

		setHighlightedTrackId(trackId);
		if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
		highlightTimeoutRef.current = setTimeout(
			() => setHighlightedTrackId(null),
			1000,
		);

		const trackTop =
			TIMELINE_CONTENT_TOP_PADDING_PX + (trackLayout.offsets[trackIndex] ?? 0);
		const trackBottom =
			trackTop + getTrackHeight({ type: tracks[trackIndex].type });
		const viewportTop = scrollEl.scrollTop;
		const viewportBottom = viewportTop + scrollEl.clientHeight;
		if (trackTop >= viewportTop && trackBottom <= viewportBottom) return;
		const top =
			trackBottom > viewportBottom
				? trackBottom - scrollEl.clientHeight
				: Math.max(0, trackTop - TIMELINE_CONTENT_TOP_PADDING_PX);
		scrollEl.scrollTo({
			top,
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}, [tracks, trackLayout]);

	// Inserting an element selects it. When that element lands outside the
	// viewport — long timelines or small zoom levels make default-duration
	// blocks only a few pixels wide, and overlapping inserts can open a new
	// track below the fold — scroll it into view so the user sees what was
	// just added instead of hunting for it. The first render is skipped so
	// restoring a project does not yank the view to a persisted selection.
	const selectedElementKey =
		selectedElements.length === 1
			? `${selectedElements[0].trackId}:${selectedElements[0].elementId}`
			: null;
	const revealedElementKeyRef = useRef<string | null>(null);
	const isFirstRevealRef = useRef(true);
	useEffect(() => {
		if (isFirstRevealRef.current) {
			isFirstRevealRef.current = false;
			revealedElementKeyRef.current = selectedElementKey;
			return;
		}
		if (
			!selectedElementKey ||
			selectedElementKey === revealedElementKeyRef.current
		) {
			return;
		}
		revealedElementKeyRef.current = selectedElementKey;

		const selected = editor.selection.getSelectedElements()[0];
		const scrollEl = tracksScrollRef.current;
		if (!selected || !scrollEl) return;
		const trackIndex = tracks.findIndex(
			(track) => track.id === selected.trackId,
		);
		const track = tracks[trackIndex];
		const element = track?.elements.find(
			(item) => item.id === selected.elementId,
		);
		if (!track || !element) return;

		const elementLeft = timelineTimeToPixels({
			time: element.startTime,
			zoomLevel,
		});
		const elementRight = timelineTimeToPixels({
			time: element.startTime + element.duration,
			zoomLevel,
		});
		const viewportLeft = scrollEl.scrollLeft;
		const viewportRight = viewportLeft + scrollEl.clientWidth;
		const isHorizontallyHidden =
			elementLeft < viewportLeft || elementRight > viewportRight;

		const trackTop =
			TIMELINE_CONTENT_TOP_PADDING_PX + (trackLayout.offsets[trackIndex] ?? 0);
		const trackBottom = trackTop + getTrackHeight({ type: track.type });
		const viewportTop = scrollEl.scrollTop;
		const viewportBottom = viewportTop + scrollEl.clientHeight;
		const isVerticallyHidden =
			trackTop < viewportTop || trackBottom > viewportBottom;

		if (!isHorizontallyHidden && !isVerticallyHidden) return;

		if (isHorizontallyHidden) {
			const elementWidth = elementRight - elementLeft;
			const centeredLeft =
				elementLeft - Math.max(0, (scrollEl.clientWidth - elementWidth) / 2);
			scrollEl.scrollLeft = Math.max(0, centeredLeft);
		}
		if (isVerticallyHidden) {
			scrollEl.scrollTop = Math.max(
				0,
				trackTop - TIMELINE_CONTENT_TOP_PADDING_PX,
			);
		}
		syncFollowers();
		saveScrollPositionRef.current();
	}, [
		selectedElementKey,
		editor,
		tracks,
		zoomLevel,
		trackLayout,
		syncFollowers,
	]);

	// Single non-passive capture listener owns all wheel input. Prevents any
	// native scroll or browser zoom from firing inside the timeline.
	useEffect(() => {
		const container = timelineRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (e: WheelEvent) => {
			const isZoom = e.ctrlKey || e.metaKey;

			if (isZoom) {
				e.preventDefault();
				const normalizedDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
				pendingZoomDelta += normalizedDelta;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const frameRawDelta = pendingZoomDelta;
						const cappedDelta =
							Math.sign(frameRawDelta) * Math.min(Math.abs(frameRawDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);
						setZoomLevelRef.current((prev) => prev * zoomFactor);
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}
				return;
			}

			const tracks = tracksScrollRef.current;
			if (!tracks) return;

			const isHorizontal =
				e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);

			e.preventDefault();

			if (isHorizontal) {
				const raw =
					Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				const clamped =
					Math.sign(raw) *
					Math.min(Math.abs(raw), TIMELINE_HORIZONTAL_WHEEL_STEP_PX);
				tracks.scrollLeft = Math.max(0, tracks.scrollLeft + clamped);
			} else {
				tracks.scrollTop = Math.max(0, tracks.scrollTop + e.deltaY);
			}

			syncFollowers();
			saveScrollPositionRef.current();
		};

		container.addEventListener("wheel", onWheel, {
			passive: false,
			capture: true,
		});
		return () => {
			container.removeEventListener("wheel", onWheel, { capture: true });
			if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
		};
	}, [syncFollowers]);

	useInitialScrollBottom({
		tracksScrollRef,
		trackLabelsScrollRef,
		onAfterScroll: () => saveScrollPositionRef.current(),
		isReady: tracks.length > 0,
	});

	const { dragView, handleElementMouseDown, handleElementClick } =
		useElementInteraction({
			zoomLevel,
			tracksContainerRef,
			tracksScrollRef,
			snappingEnabled,
			onSnapPointChange: handleSnapPointChange,
			trackLayout,
		});
	const isElementDragging = dragView.kind === "dragging";
	// Same-track drags already render the element at the landing slot — the
	// ghost block would just dim it.
	const isSameTrackElementDrag =
		dragView.kind === "dragging" &&
		dragView.dropTarget != null &&
		!dragView.dropTarget.isNewTrack &&
		tracks[dragView.dropTarget.trackIndex]?.id === dragView.trackId;
	// Effect elements dropped onto a visual element attach to it instead of
	// moving — highlight that element the same way external drops do.
	const elementDragTargetId =
		dragView.kind === "dragging"
			? (dragView.dropTarget?.targetElement?.elementId ?? null)
			: null;

	const {
		dragState: bookmarkDragState,
		handleBookmarkMouseDown,
		lastMouseXRef: bookmarkLastMouseXRef,
	} = useBookmarkDrag({
		zoomLevel,
		scrollRef: tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
	});

	const {
		handlePlayheadMouseDown,
		handleRulerMouseDown: handlePlayheadRulerMouseDown,
		getLastMouseClientX: getPlayheadLastMouseClientX,
	} = useTimelinePlayhead({
		zoomLevel,
		rulerRef,
		rulerScrollRef,
		tracksScrollRef,
		playheadRef,
	});

	const isRangeMarking = useUserMarksStore((s) => s.isRangeMarking);
	const isRangeDragActive = useUserMarksStore((s) => s.draftTimeRange !== null);
	const {
		onRangeSelectMouseDown,
		onRangeSelectClickCapture,
		lastMouseXRef: rangeSelectLastMouseXRef,
	} = useTimelineRangeSelect({
		getRulerEl: () => rulerRef.current,
		zoomLevel,
	});

	const { isDragOver, dropTarget, dragProps } = useTimelineDragDrop({
		containerRef: tracksContainerRef,
		tracksScrollRef,
		zoomLevel,
		trackLayout,
	});

	const {
		selectionBox,
		handleMouseDown: handleSelectionMouseDown,
		isSelecting,
		shouldIgnoreClick,
	} = useBoxSelect({
		containerRef: tracksContainerRef,
		selectedIds: selectedElements,
		anchorId: null,
		getIsAdditiveSelection: (event) =>
			event.shiftKey || event.ctrlKey || event.metaKey,
		resolveIntersections: ({ startPos, currentPos }) => {
			if (!tracksContainerRef.current) {
				return [];
			}

			return resolveTimelineElementIntersections({
				container: tracksContainerRef.current,
				scrollContainer: tracksScrollRef.current,
				tracks,
				zoomLevel,
				startPos,
				currentPos,
				trackOffsets: trackLayout.offsets,
			});
		},
		onSelectionChange: ({ intersectedIds, isAdditive }) => {
			const selectableIds = intersectedIds.filter(
				(ref) => !lockedTrackIds.has(ref.trackId),
			);
			if (isAdditive) {
				mergeElementsIntoSelection({ elements: selectableIds });
			} else {
				setElementSelection({ elements: selectableIds });
			}
		},
	});

	const contentWidth = timelineTimeToPixels({
		time: timelineDuration,
		zoomLevel,
	});
	const paddingPx = getTimelinePaddingPx({
		containerWidth,
		zoomLevel,
		minZoom: minZoomLevel,
		maxZoom: maxZoomLevel,
	});
	const dynamicTimelineWidth = Math.max(
		contentWidth + paddingPx,
		containerWidth,
	);
	const hasHorizontalScrollbar =
		dynamicTimelineWidth > (tracksViewportWidth || containerWidth);

	// Zoom changes the content width; the store must re-measure so windowed
	// consumers don't compute against a stale viewport for a frame.
	useLayoutEffect(() => {
		timelineViewport.readNow();
	}, [dynamicTimelineWidth]);

	useEdgeAutoScroll({
		isActive: bookmarkDragState.isDragging,
		getMouseClientX: () => bookmarkLastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	useEdgeAutoScroll({
		isActive: isElementDragging,
		getMouseClientX: () =>
			dragView.kind === "dragging" ? dragView.currentMouseX : 0,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	useEdgeAutoScroll({
		isActive: isRangeMarking && isRangeDragActive,
		getMouseClientX: () => rangeSelectLastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	const showSnapIndicator =
		snappingEnabled &&
		currentSnapPoint !== null &&
		(isElementDragging || bookmarkDragState.isDragging || isResizing);

	const {
		handleTracksMouseDown,
		handleTracksClick,
		handleRulerMouseDown,
		handleRulerClick,
	} = useTimelineSeek({
		playheadRef,
		trackLabelsRef,
		rulerScrollRef,
		tracksScrollRef,
		zoomLevel,
		duration: timeline.getTotalDuration(),
		isSelecting,
		clearSelectedElements: clearElementSelection,
		seek,
	});

	const timelineHeaderHeight =
		timelineHeaderHeightValue + TIMELINE_CONTENT_TOP_PADDING_PX;

	// Stable identities so the memoized children below only re-render when
	// their data actually changes.
	const handleToolbarZoomChange = useCallback(
		({ zoom }: { zoom: number }) => setZoomLevel(zoom),
		[setZoomLevel],
	);
	const handleTrackRowMouseDown = useCallback(
		(event: React.MouseEvent) => {
			handleSelectionMouseDown(event);
			handleTracksMouseDown(event);
		},
		[handleSelectionMouseDown, handleTracksMouseDown],
	);
	const handleGutterMouseDown = useCallback(
		(event: React.MouseEvent) => {
			handleTracksMouseDown(event);
			handleSelectionMouseDown(event);
		},
		[handleSelectionMouseDown, handleTracksMouseDown],
	);

	return (
		<section
			className={
				"panel bg-background relative flex h-full flex-col overflow-hidden rounded-sm border"
			}
			{...dragProps}
			aria-label={t("timeline.timeline")}
		>
			<TimelineToolbar
				zoomLevel={zoomLevel}
				minZoom={minZoomLevel}
				setZoomLevel={handleToolbarZoomChange}
				onAddTrack={handleAddTrack}
			/>
			<PlayheadScrubAutoScroll
				getMouseClientX={getPlayheadLastMouseClientX}
				rulerScrollRef={rulerScrollRef}
				tracksScrollRef={tracksScrollRef}
				contentWidth={contentWidth}
			/>

			<div className="relative flex flex-1 overflow-hidden" ref={timelineRef}>
				<TrackLabelsPanel
					trackLabelsRef={trackLabelsRef}
					trackLabelsScrollRef={trackLabelsScrollRef}
					timelineHeaderHeight={timelineHeaderHeight}
					hasHorizontalScrollbar={hasHorizontalScrollbar}
					getTrackExpansionHeight={getTrackExpansionHeight}
					highlightedTrackId={highlightedTrackId}
				/>

				<div
					className={cn(
						"relative isolate flex flex-1 flex-col overflow-hidden",
						isRangeMarking ? "cursor-crosshair" : "",
					)}
					ref={tracksContainerRef}
					onMouseDownCapture={(event) => {
						if (!isRangeMarking) return;
						// Let the range band's own clear button receive the press —
						// this capture handler runs before the button can stop it.
						if (
							event.target instanceof HTMLElement &&
							event.target.closest("[data-user-mark-action]")
						) {
							return;
						}
						onRangeSelectMouseDown(event);
					}}
					onClickCapture={onRangeSelectClickCapture}
				>
					<SelectionBox bounds={selectionBox?.bounds ?? null} />
					<DragLine
						dropTarget={dropTarget}
						tracks={tracks}
						isVisible={isDragOver && !dropTarget?.targetElement}
						headerHeight={timelineHeaderHeight}
						zoomLevel={zoomLevel}
						trackOffsets={trackLayout.offsets}
						trackTotalHeight={trackLayout.totalHeight}
					/>
					<DragLine
						dropTarget={isElementDragging ? dragView.dropTarget : null}
						tracks={tracks}
						isVisible={isElementDragging && elementDragTargetId === null}
						headerHeight={timelineHeaderHeight}
						zoomLevel={zoomLevel}
						suppressGhost={isSameTrackElementDrag}
						trackOffsets={trackLayout.offsets}
						trackTotalHeight={trackLayout.totalHeight}
					/>

					<div ref={rulerScrollRef} className="shrink-0 overflow-hidden">
						<div
							ref={timelineHeaderRef}
							className="flex flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							<TimelineRuler
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								rulerRef={rulerRef}
								handleTimelineContentClick={handleRulerClick}
								handleRulerTrackingMouseDown={handleRulerMouseDown}
								handleRulerMouseDown={handlePlayheadRulerMouseDown}
							/>
							<TimelineBookmarksRow
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								dragState={bookmarkDragState}
								onBookmarkMouseDown={handleBookmarkMouseDown}
								handleTimelineContentClick={handleRulerClick}
								handleRulerTrackingMouseDown={handleRulerMouseDown}
								handleRulerMouseDown={handlePlayheadRulerMouseDown}
							/>
						</div>
					</div>

					<ScrollArea
						className="flex-1"
						ref={tracksScrollRef}
						onScroll={() => {
							syncFollowers();
							saveScrollPosition();
						}}
					>
						<div
							className="relative flex min-h-full flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							<TimeRangeOverlay zoomLevel={zoomLevel} />
							{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (tracks container background); direct-target clicks here originate box-select or clear selection. Keyboard control is global timeline shortcuts. */}
							<div
								className="relative shrink-0"
								style={{
									height: `${
										Math.max(
											TRACKS_CONTAINER_HEIGHT.min,
											Math.min(
												TRACKS_CONTAINER_HEIGHT.max,
												trackLayout.totalHeight,
											),
										) + TIMELINE_CONTENT_TOP_PADDING_PX
									}px`,
								}}
								onMouseDown={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									handleTracksClick(event);
								}}
							>
								{tracks.length > 0 && (
									<TimelineLiveZoomContext.Provider value={zoomLevel}>
										<TimelineTrackRows
											mainTrackId={mainTrackId}
											zoomLevel={deferredZoomLevel}
											dragView={dragView}
											onResizeStart={handleResizeStart}
											onElementMouseDown={handleElementMouseDown}
											onElementClick={handleElementClick}
											onTrackMouseDown={handleTrackRowMouseDown}
											onTrackMouseUp={handleTracksClick}
											shouldIgnoreClick={shouldIgnoreClick}
											isDragOver={isDragOver}
											dropTarget={dropTarget}
											elementDragTargetId={elementDragTargetId}
											highlightedTrackId={highlightedTrackId}
										/>
									</TimelineLiveZoomContext.Provider>
								)}
							</div>
							<TimelineGutter
								onMouseDown={handleGutterMouseDown}
								onClick={handleTracksClick}
								onAddTrack={handleAddTrack}
							/>
						</div>
					</ScrollArea>

					<TimelinePlayhead
						hasHorizontalScrollbar={hasHorizontalScrollbar}
						tracksScrollRef={tracksScrollRef}
						timelineRef={timelineRef}
						playheadRef={playheadRef}
						onPlayheadMouseDown={handlePlayheadMouseDown}
						isSnappingToPlayhead={
							showSnapIndicator && currentSnapPoint?.type === "playhead"
						}
					/>
				</div>
				<SnapIndicator
					snapPoint={currentSnapPoint}
					zoomLevel={zoomLevel}
					timelineRef={timelineRef}
					isVisible={showSnapIndicator}
				/>
			</div>
		</section>
	);
}

function PlayheadScrubAutoScroll(
	props: Parameters<typeof usePlayheadScrubAutoScroll>[0],
) {
	usePlayheadScrubAutoScroll(props);
	return null;
}

const TrackLabelsPanel = memo(function TrackLabelsPanel({
	trackLabelsRef,
	trackLabelsScrollRef,
	timelineHeaderHeight,
	hasHorizontalScrollbar,
	getTrackExpansionHeight,
	highlightedTrackId,
}: {
	trackLabelsRef: React.RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineHeaderHeight: number;
	hasHorizontalScrollbar: boolean;
	getTrackExpansionHeight: (trackIndex: number) => number;
	highlightedTrackId: string | null;
}) {
	const t = useT();
	const editor = useEditor();
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const mainTrackId = scene?.tracks.main.id ?? null;
	const overlayTrackIds = useMemo(
		() => scene?.tracks.overlay.map((track) => track.id) ?? [],
		[scene],
	);
	const audioTrackIds = useMemo(
		() => scene?.tracks.audio.map((track) => track.id) ?? [],
		[scene],
	);
	const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	// Escape unmounts the input, which fires blur — without this flag the
	// blur handler would commit the draft the user meant to discard.
	const renameCancelledRef = useRef(false);
	const { selectedElements } = useElementSelection();
	const tracksWithSelection = useMemo(
		() => new Set(selectedElements.map((el) => el.trackId)),
		[selectedElements],
	);

	const commitRename = useCallback(() => {
		if (renameCancelledRef.current) {
			renameCancelledRef.current = false;
			setRenamingTrackId(null);
			return;
		}
		const currentId = renamingTrackId;
		if (currentId) {
			const nextName = renameDraft.trim();
			// Read live state: Enter fires before blur, and both call this —
			// the second call must no-op instead of pushing a duplicate command.
			const current = editor.timeline.getTrackById({ trackId: currentId });
			if (current && nextName.length > 0 && nextName !== current.name) {
				editor.timeline.updateTrack({
					trackId: currentId,
					patch: { name: nextName },
				});
			}
		}
		setRenamingTrackId(null);
	}, [renamingTrackId, renameDraft, editor]);

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);
	const trackExpandedRowsMap = useMemo(
		() =>
			tracks.map((track) =>
				getTrackExpandedRows({ track, expandedElementIds }),
			),
		[tracks, expandedElementIds],
	);

	return (
		<div
			className="flex shrink-0 flex-col border-r"
			style={{ width: `${TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX}px` }}
		>
			<div
				className="shrink-0"
				style={{ height: timelineHeaderHeight || 48 }}
			/>
			<div ref={trackLabelsRef} className="flex-1 overflow-hidden">
				<div ref={trackLabelsScrollRef} className="size-full overflow-hidden">
					{tracks.length > 0 && (
						<div
							className="flex flex-col"
							style={{ gap: `${TIMELINE_TRACK_GAP_PX}px` }}
						>
							{tracks.map((track, index) => {
								const expandedRows = trackExpandedRowsMap[index];
								const baseHeight = getTrackHeight({ type: track.type });
								const overlayIndex = overlayTrackIds.indexOf(track.id);
								const audioIndex = audioTrackIds.indexOf(track.id);
								const canMoveUp = overlayIndex > 0 || audioIndex > 0;
								const canMoveDown =
									(overlayIndex >= 0 &&
										overlayIndex < overlayTrackIds.length - 1) ||
									(audioIndex >= 0 && audioIndex < audioTrackIds.length - 1);

								return (
									<TrackContextMenu
										key={track.id}
										track={track}
										mainTrackId={mainTrackId}
										canMoveUp={canMoveUp}
										canMoveDown={canMoveDown}
									>
										<div
											className={cn(
												"group/track relative flex flex-col transition-colors",
												tracksWithSelection.has(track.id) &&
													SELECTED_TRACK_ROW_CLASS,
												canTrackBeHidden(track) && track.hidden && "opacity-50",
												highlightedTrackId === track.id &&
													"bg-primary/10 ring-primary/40 ring-1 ring-inset",
											)}
											style={{
												height: `${baseHeight + getTrackExpansionHeight(index)}px`,
											}}
										>
											<div
												className="relative flex shrink-0 items-center gap-1 px-2"
												style={{ height: `${baseHeight}px` }}
											>

												{renamingTrackId === track.id ? (
													<input
														ref={(el) => el?.focus()}
														data-escape-handled
														className="bg-background border-input absolute inset-x-2 top-1/2 z-10 h-6 -translate-y-1/2 rounded-sm border px-1 text-xs leading-none"
														value={renameDraft}
														onChange={(event) =>
															setRenameDraft(event.target.value)
														}
														onBlur={commitRename}
														onKeyDown={(event) => {
															if (event.key === "Enter") commitRename();
															if (event.key === "Escape") {
																renameCancelledRef.current = true;
																setRenamingTrackId(null);
															}
														}}
														onClick={(event) => event.stopPropagation()}
														onMouseDown={(event) => event.stopPropagation()}
													/>
												) : (
													<span
														className="text-muted-foreground min-w-0 flex-1 cursor-text truncate text-[11px] leading-none select-none group-hover/track:hidden"
														title={`${track.name} — ${t("timeline.renameTrack")}`}
														onDoubleClick={() => {
															renameCancelledRef.current = false;
															setRenamingTrackId(track.id);
															setRenameDraft(track.name);
														}}
													>
														{track.name}
													</span>
												)}
												<div
													className={cn(
														"bg-background/95 absolute inset-x-1 inset-y-0 flex items-center justify-start gap-1 opacity-0 transition-opacity group-hover/track:opacity-100",
														renamingTrackId === track.id && "hidden",
													)}
												>
													{track.type === "text" && (
														<button
															type="button"
															className="hover:bg-muted flex size-6 items-center justify-center rounded-sm"
															aria-label={
																track.linkedStyle
																	? t("timeline.unlinkCaptionStyle")
																	: t("timeline.linkCaptionStyle")
															}
															title={
																track.linkedStyle
																	? t("timeline.unlinkCaptionStyle")
																	: t("timeline.linkCaptionStyle")
															}
															onClick={() =>
																editor.timeline.toggleTrackLinkedStyle({
																	trackId: track.id,
																})
															}
														>
															<HugeiconsIcon
																icon={
																	track.linkedStyle ? Link02Icon : Unlink02Icon
																}
																className={cn(
																	"size-[18px]",
																	track.linkedStyle
																		? "text-foreground"
																		: "text-muted-foreground",
																)}
															/>
														</button>
													)}
													{canTrackHaveAudio(track) && (
														<TrackToggleIcon
															isOff={track.muted}
															icons={{ on: VolumeHighIcon, off: VolumeOffIcon }}
															label={
																track.muted
																	? t("timeline.unmuteTrack")
																	: t("timeline.muteTrack")
															}
															onClick={() =>
																editor.timeline.toggleTrackMute({
																	trackId: track.id,
																})
															}
														/>
													)}
													{canTrackBeHidden(track) &&
														track.id !== mainTrackId && (
															<TrackToggleIcon
																isOff={track.hidden}
																icons={{ on: ViewIcon, off: ViewOffSlashIcon }}
																label={
																	track.hidden
																		? t("timeline.showTrack")
																		: t("timeline.hideTrack")
																}
																onClick={() =>
																	editor.timeline.toggleTrackVisibility({
																		trackId: track.id,
																	})
																}
															/>
														)}
													<TrackToggleIcon
														isOff={track.locked ?? false}
														icons={{ on: LockIcon, off: LockIcon }}
														label={
															track.locked
																? t("timeline.unlockTrack")
																: t("timeline.lockTrack")
														}
														onClick={() =>
															editor.timeline.toggleTrackLocked({
																trackId: track.id,
															})
														}
													/>
													<TrackOptionsMenu
														track={track}
														mainTrackId={mainTrackId}
														canMoveUp={canMoveUp}
														canMoveDown={canMoveDown}
													/>
												</div>
											</div>
											{expandedRows.length > 0 && (
												<PropertyTree rows={expandedRows} />
											)}
										</div>
									</TrackContextMenu>
								);
							})}
						</div>
					)}
				</div>
			</div>
			<div
				className="bg-background shrink-0"
				style={{
					height: hasHorizontalScrollbar ? TIMELINE_SCROLLBAR_SIZE_PX : 0,
				}}
			/>
		</div>
	);
});

const TimelineTrackRows = memo(function TimelineTrackRows({
	mainTrackId,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	isDragOver,
	dropTarget,
	elementDragTargetId,
	highlightedTrackId,
}: {
	mainTrackId: string | null;
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: React.ComponentProps<
		typeof TimelineTrackContent
	>["onResizeStart"];
	onElementMouseDown: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementMouseDown"];
	onElementClick: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementClick"];
	onTrackMouseDown: (event: React.MouseEvent) => void;
	onTrackMouseUp: (event: React.MouseEvent) => void;
	shouldIgnoreClick: () => boolean;
	isDragOver: boolean;
	dropTarget: DropTarget | null;
	elementDragTargetId: string | null;
	highlightedTrackId: string | null;
}) {
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const overlayTrackIds = useMemo(
		() => scene?.tracks.overlay.map((track) => track.id) ?? [],
		[scene],
	);
	const audioTrackIds = useMemo(
		() => scene?.tracks.audio.map((track) => track.id) ?? [],
		[scene],
	);
	const { selectedElements } = useElementSelection();
	const tracksWithSelection = useMemo(
		() => new Set(selectedElements.map((el) => el.trackId)),
		[selectedElements],
	);

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	// Prefix sums shared by every row, instead of an O(n) walk per row.
	const trackOffsets = useMemo(
		() =>
			getTrackOffsets({
				tracks,
				getExtraHeight: getTrackExpansionHeight,
			}).offsets,
		[tracks, getTrackExpansionHeight],
	);

	const draggingElementIds = useMemo(
		() =>
			dragView.kind === "dragging"
				? dragView.memberTimeOffsets
				: (null as ReadonlyMap<string, MediaTime> | null),
		[dragView],
	);
	const sortedTracks = useMemo(() => {
		if (!draggingElementIds)
			return tracks.map((track, index) => ({ track, index }));
		return [...tracks]
			.map((track, index) => ({ track, index }))
			.sort((a, b) => {
				const aHasDragged = a.track.elements.some((element) =>
					draggingElementIds.has(element.id),
				);
				const bHasDragged = b.track.elements.some((element) =>
					draggingElementIds.has(element.id),
				);
				if (aHasDragged) return 1;
				if (bHasDragged) return -1;
				return 0;
			});
	}, [tracks, draggingElementIds]);

	return (
		<>
			{sortedTracks.map(({ track, index }) => {
				const overlayIndex = overlayTrackIds.indexOf(track.id);
				const audioIndex = audioTrackIds.indexOf(track.id);
				const canMoveUp = overlayIndex > 0 || audioIndex > 0;
				const canMoveDown =
					(overlayIndex >= 0 && overlayIndex < overlayTrackIds.length - 1) ||
					(audioIndex >= 0 && audioIndex < audioTrackIds.length - 1);

				return (
					<TrackContextMenu
						key={track.id}
						track={track}
						mainTrackId={mainTrackId}
						canMoveUp={canMoveUp}
						canMoveDown={canMoveDown}
					>
						<div
							className={cn(
								"absolute right-0 left-0 transition-colors",
								tracksWithSelection.has(track.id) && SELECTED_TRACK_ROW_CLASS,
								canTrackBeHidden(track) && track.hidden && "opacity-50",
								track.locked && "cursor-not-allowed bg-muted/40",
								highlightedTrackId === track.id && "bg-primary/10",
							)}
							style={{
								top: `${TIMELINE_CONTENT_TOP_PADDING_PX + (trackOffsets[index] ?? 0)}px`,
								height: `${getTrackHeight({ type: track.type }) + getTrackExpansionHeight(index)}px`,
							}}
						>
							<TimelineTrackContent
								track={track}
								index={index}
								zoomLevel={zoomLevel}
								dragView={dragView}
								onResizeStart={onResizeStart}
								onElementMouseDown={onElementMouseDown}
								onElementClick={onElementClick}
								onTrackMouseDown={onTrackMouseDown}
								onTrackMouseUp={onTrackMouseUp}
								shouldIgnoreClick={shouldIgnoreClick}
								targetElementId={
									isDragOver
										? (dropTarget?.targetElement?.elementId ?? null)
										: elementDragTargetId
								}
							/>
						</div>
					</TrackContextMenu>
				);
			})}
		</>
	);
});

type TrackMenuItemComponent = React.ComponentType<{
	children: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
	onClick?: (event: React.MouseEvent) => void;
	variant?: "destructive";
}>;

interface TrackMenuProps {
	track: TimelineTrack;
	mainTrackId: string | null;
	canMoveUp: boolean;
	canMoveDown: boolean;
}

function TrackMenu({
	track,
	mainTrackId,
	canMoveUp,
	canMoveDown,
	Item,
	renderMenu,
}: TrackMenuProps & {
	Item: TrackMenuItemComponent;
	renderMenu: (items: ReactNode) => ReactNode;
}) {
	const t = useT();
	const editor = useEditor();
	const timeline = editor.timeline;
	const clipboardEntry = useClipboardEntry();
	const [isDeletePending, setIsDeletePending] = useState(false);

	const items = (
		<>
			<Item
				icon={<HugeiconsIcon icon={TaskAdd02Icon} />}
				disabled={!canPasteEntryOnTrack({ entry: clipboardEntry, track })}
				onClick={(event) => {
					event.stopPropagation();
					editor.clipboard.paste({ targetTrackId: track.id });
				}}
			>
				{t("timeline.pasteElements")}
			</Item>
			{canTrackHaveAudio(track) && (
				<Item
					icon={<HugeiconsIcon icon={VolumeHighIcon} />}
					onClick={(event) => {
						event.stopPropagation();
						timeline.toggleTrackMute({ trackId: track.id });
					}}
				>
					{track.muted ? t("timeline.unmuteTrack") : t("timeline.muteTrack")}
				</Item>
			)}
			{canTrackBeHidden(track) && track.id !== mainTrackId && (
				<Item
					icon={<HugeiconsIcon icon={ViewIcon} />}
					onClick={(event) => {
						event.stopPropagation();
						timeline.toggleTrackVisibility({ trackId: track.id });
					}}
				>
					{track.hidden ? t("timeline.showTrack") : t("timeline.hideTrack")}
				</Item>
			)}
			<Item
				icon={<HugeiconsIcon icon={LockIcon} />}
				onClick={(event) => {
					event.stopPropagation();
					timeline.toggleTrackLocked({ trackId: track.id });
				}}
			>
				{track.locked ? t("timeline.unlockTrack") : t("timeline.lockTrack")}
			</Item>
			{track.id !== mainTrackId && (
				<>
					<Item
						icon={<HugeiconsIcon icon={ArrowUp01Icon} />}
						disabled={!canMoveUp}
						onClick={(event) => {
							event.stopPropagation();
							timeline.moveTrack({ trackId: track.id, direction: "up" });
						}}
					>
						{t("timeline.moveTrackUp")}
					</Item>
					<Item
						icon={<HugeiconsIcon icon={ArrowDown01Icon} />}
						disabled={!canMoveDown}
						onClick={(event) => {
							event.stopPropagation();
							timeline.moveTrack({ trackId: track.id, direction: "down" });
						}}
					>
						{t("timeline.moveTrackDown")}
					</Item>
					<Item
						icon={<HugeiconsIcon icon={Delete02Icon} />}
						disabled={track.locked}
						onClick={(event) => {
							event.stopPropagation();
							if (track.elements.length > 0) {
								setIsDeletePending(true);
							} else {
								timeline.removeTrack({ trackId: track.id });
							}
						}}
						variant="destructive"
					>
						{track.locked
							? t("timeline.deleteTrackLocked")
							: t("timeline.deleteTrack")}
					</Item>
				</>
			)}
		</>
	);

	return (
		<>
			{renderMenu(items)}
			<AlertDialog open={isDeletePending} onOpenChange={setIsDeletePending}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("timeline.deleteTrackConfirmTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("timeline.deleteTrackConfirmDescription", {
								name: track.name,
								count: track.elements.length,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								timeline.removeTrack({ trackId: track.id });
								setIsDeletePending(false);
							}}
						>
							{t("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function TrackContextMenu({
	children,
	...props
}: TrackMenuProps & { children: ReactNode }) {
	return (
		<TrackMenu
			{...props}
			Item={ContextMenuItem}
			renderMenu={(items) => (
				<ContextMenu>
					<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
					<ContextMenuContent className="w-40">{items}</ContextMenuContent>
				</ContextMenu>
			)}
		/>
	);
}

function TrackOptionsMenu(props: TrackMenuProps) {
	const t = useT();
	return (
		<TrackMenu
			{...props}
			Item={DropdownMenuItem}
			renderMenu={(items) => (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="hover:bg-muted flex size-6 items-center justify-center rounded-sm"
							aria-label={t("timeline.trackOptions")}
							title={t("timeline.trackOptions")}
							onClick={(event) => event.stopPropagation()}
							onDoubleClick={(event) => event.stopPropagation()}
						>
							<HugeiconsIcon
								icon={MoreHorizontalIcon}
								className="text-muted-foreground size-[18px]"
							/>
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-40">
						{items}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		/>
	);
}

const TimelineGutter = memo(function TimelineGutter({
	onMouseDown,
	onClick,
	onAddTrack,
}: {
	onMouseDown: (event: React.MouseEvent) => void;
	onClick: (event: React.MouseEvent) => void;
	onAddTrack: (type: (typeof ADDABLE_TRACK_TYPES)[number]["type"]) => void;
}) {
	const t = useT();
	const hasClipboardEntry = useClipboardHasEntry();
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (empty space below tracks); clicks here clear selection. Keyboard control is global timeline shortcuts. */}
				<div className="flex-1" onMouseDown={onMouseDown} onClick={onClick} />
			</ContextMenuTrigger>
			<ContextMenuContent className="w-40">
				<ContextMenuItem
					icon={<HugeiconsIcon icon={TaskAdd02Icon} />}
					disabled={!hasClipboardEntry}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						invokeAction("paste-copied");
					}}
				>
					{t("timeline.pasteElements")}
				</ContextMenuItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						{t("timeline.addTrack")}
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{ADDABLE_TRACK_TYPES.map(({ type, labelKey }) => (
							<ContextMenuItem
								key={type}
								onClick={(event: React.MouseEvent) => {
									event.stopPropagation();
									onAddTrack(type);
								}}
							>
								{t(labelKey)}
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>
			</ContextMenuContent>
		</ContextMenu>
	);
});

function TrackToggleIcon({
	isOff,
	icons,
	label,
	onClick,
}: {
	isOff: boolean;
	icons: {
		on: IconSvgElement;
		off: IconSvgElement;
	};
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={isOff}
			className="hover:bg-muted flex size-6 items-center justify-center rounded-sm"
			onClick={onClick}
		>
			<HugeiconsIcon
				icon={isOff ? icons.off : icons.on}
				className={cn(
					"size-[18px]",
					isOff ? "text-destructive" : "text-muted-foreground",
				)}
			/>
		</button>
	);
}

function PropertyTree({ rows }: { rows: ExpandedRow[] }) {
	useLocale();
	return (
		<div className="flex flex-col overflow-hidden">
			{rows.map((row) => (
				<div
					key={row.propertyPath}
					className={cn("flex shrink-0 items-center px-3 bg-muted/50")}
					style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
				>
					<span className="text-muted-foreground truncate text-xs leading-none">
						{getPropertyLabel(row.propertyPath)}
					</span>
				</div>
			))}
		</div>
	);
}

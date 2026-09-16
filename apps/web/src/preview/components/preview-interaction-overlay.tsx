import { useState } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { usePreviewInteraction } from "@/preview/hooks/use-preview-interaction";
import type { SnapLine } from "@/preview/preview-snap";
import { TransformHandles } from "./transform-handles";
import { MaskHandles } from "./mask-handles";
import { SnapGuides } from "./snap-guides";
import { TextEditOverlay } from "./text-edit-overlay";
import { RegionMarkOverlay, type RegionMarkDraft } from "./region-mark-overlay";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useEditor } from "@/editor/use-editor";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { mediaTimeToSeconds } from "@/wasm";
import { clamp } from "@/utils/math";
import { useT } from "@/i18n";

/** Ignore drags smaller than this fraction of the canvas — accidental clicks. */
const MIN_MARK_FRACTION = 0.01;

export function PreviewInteractionOverlay() {
	const t = useT();
	const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const activeTabPerType = usePropertiesStore((s) => s.activeTabPerType);

	const selectedRef =
		selectedElements.length === 1 ? selectedElements[0] : null;
	const activeTrack = selectedRef
		? editor.timeline.getTrackById({ trackId: selectedRef.trackId })
		: null;
	const activeElement =
		activeTrack?.elements.find(
			(element) => element.id === selectedRef?.elementId,
		) ?? null;
	const isMaskMode = activeElement
		? activeTabPerType[activeElement.type] === "masks"
		: false;

	const isRegionMarking = useUserMarksStore((s) => s.isRegionMarking);
	const setCanvasRect = useUserMarksStore((s) => s.setCanvasRect);
	const setRegionMarking = useUserMarksStore((s) => s.setRegionMarking);
	const canvasSize = useEditor(
		(e) => e.project.getActiveOrNull()?.settings.canvasSize,
	);
	const [regionDraft, setRegionDraft] = useState<RegionMarkDraft | null>(null);

	const {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onDoubleClick,
		editingText,
		commitTextEdit,
	} = usePreviewInteraction({
		onSnapLinesChange: setSnapLines,
		isMaskMode,
	});

	const handlePointerDown = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerDown({ event })) {
			return;
		}

		if (isRegionMarking) {
			const point = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (!point) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			setRegionDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
			return;
		}

		onPointerDown(event);
	};

	const handlePointerMove = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerMove({ event })) {
			return;
		}

		if (regionDraft) {
			const point = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (point) {
				setRegionDraft((draft) =>
					draft ? { ...draft, x1: point.x, y1: point.y } : draft,
				);
			}
			return;
		}

		onPointerMove(event);
	};

	const handlePointerUp = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerUp({ event })) {
			return;
		}

		if (regionDraft) {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			if (canvasSize) {
				const left = clamp({
					value: Math.min(regionDraft.x0, regionDraft.x1) / canvasSize.width,
					min: 0,
					max: 1,
				});
				const top = clamp({
					value: Math.min(regionDraft.y0, regionDraft.y1) / canvasSize.height,
					min: 0,
					max: 1,
				});
				const right = clamp({
					value: Math.max(regionDraft.x0, regionDraft.x1) / canvasSize.width,
					min: 0,
					max: 1,
				});
				const bottom = clamp({
					value: Math.max(regionDraft.y0, regionDraft.y1) / canvasSize.height,
					min: 0,
					max: 1,
				});
				if (
					right - left >= MIN_MARK_FRACTION &&
					bottom - top >= MIN_MARK_FRACTION
				) {
					setCanvasRect({
						left,
						top,
						right,
						bottom,
						time: mediaTimeToSeconds({
							time: editor.playback.getCurrentTime(),
						}),
					});
				}
			}
			setRegionDraft(null);
			setRegionMarking(false);
			return;
		}

		onPointerUp(event);
	};

	return (
		<div className="absolute inset-0">
			<div
				className="absolute inset-0 pointer-events-auto"
				role="application"
				aria-label={t("shell.previewCanvas")}
				style={{
					cursor: isRegionMarking
						? "crosshair"
						: viewport.isPanning
							? "grabbing"
							: viewport.canPan
								? "default"
								: undefined,
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				onDoubleClick={onDoubleClick}
				onDragStart={(e) => e.preventDefault()}
			/>
			{editingText ? (
				<TextEditOverlay
					trackId={editingText.trackId}
					elementId={editingText.elementId}
					element={editingText.element}
					onCommit={commitTextEdit}
				/>
			) : isMaskMode ? (
				<MaskHandles onSnapLinesChange={setSnapLines} />
			) : (
				<TransformHandles onSnapLinesChange={setSnapLines} />
			)}
			<SnapGuides lines={snapLines} />
			<RegionMarkOverlay draft={regionDraft} />
		</div>
	);
}

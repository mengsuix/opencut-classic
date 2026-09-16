"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEditor } from "@/editor/use-editor";
import { useUserMarksStore } from "@/editor/user-marks-store";
import { useT } from "@/i18n";
import { usePreviewViewport } from "./preview-viewport";

/** In-progress drag rect, in canvas pixel coordinates. */
export interface RegionMarkDraft {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * Renders the user's canvas-region mark (drawn via the region-marking mode
 * in the preview toolbar): the persistent rect plus the in-progress draft.
 * Pure overlay — pointer events pass through except the clear button.
 */
export function RegionMarkOverlay({ draft }: { draft: RegionMarkDraft | null }) {
	const t = useT();
	const viewport = usePreviewViewport();
	const canvasSize = useEditor(
		(e) => e.project.getActiveOrNull()?.settings.canvasSize,
	);
	const canvasRect = useUserMarksStore((s) => s.canvasRect);
	const clearCanvasRect = useUserMarksStore((s) => s.clearCanvasRect);

	if (!canvasSize) {
		return null;
	}

	const toOverlay = (x: number, y: number) =>
		viewport.canvasToOverlay({ canvasX: x, canvasY: y });

	let markBox: { left: number; top: number; width: number; height: number } | null =
		null;
	if (canvasRect) {
		const p1 = toOverlay(
			canvasRect.left * canvasSize.width,
			canvasRect.top * canvasSize.height,
		);
		const p2 = toOverlay(
			canvasRect.right * canvasSize.width,
			canvasRect.bottom * canvasSize.height,
		);
		markBox = {
			left: p1.x,
			top: p1.y,
			width: p2.x - p1.x,
			height: p2.y - p1.y,
		};
	}

	let draftBox: { left: number; top: number; width: number; height: number } | null =
		null;
	if (draft) {
		const p1 = toOverlay(
			Math.min(draft.x0, draft.x1),
			Math.min(draft.y0, draft.y1),
		);
		const p2 = toOverlay(
			Math.max(draft.x0, draft.x1),
			Math.max(draft.y0, draft.y1),
		);
		draftBox = {
			left: p1.x,
			top: p1.y,
			width: p2.x - p1.x,
			height: p2.y - p1.y,
		};
	}

	return (
		<div className="pointer-events-none absolute inset-0">
			{markBox && (
				<div
					className="border-primary bg-primary/10 absolute border-2 border-dashed"
					style={{
						left: markBox.left,
						top: markBox.top,
						width: markBox.width,
						height: markBox.height,
					}}
				>
					<button
						type="button"
						aria-label={t("shell.clearRegionMark")}
						title={t("shell.clearRegionMark")}
						className="bg-background text-foreground pointer-events-auto absolute top-0.5 right-0.5 flex size-4 cursor-pointer items-center justify-center rounded-sm border"
						onClick={clearCanvasRect}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
					</button>
				</div>
			)}
			{draftBox && (
				<div
					className="border-primary/60 bg-primary/5 absolute border-2 border-dashed"
					style={{
						left: draftBox.left,
						top: draftBox.top,
						width: draftBox.width,
						height: draftBox.height,
					}}
				/>
			)}
		</div>
	);
}

"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEditor } from "@/editor/use-editor";
import {
	useUserMarksStore,
	type CanvasRectMark,
} from "@/editor/user-marks-store";
import { useT } from "@/i18n";
import { usePreviewViewport } from "./preview-viewport";

/** In-progress drag rect, in canvas pixel coordinates. */
export interface RegionMarkDraft {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface OverlayBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Renders the user's canvas-region marks (drawn via the region-marking mode
 * in the preview toolbar): every persistent rect plus the in-progress draft.
 * Pure overlay — pointer events pass through except the clear buttons.
 */
export function RegionMarkOverlay({ draft }: { draft: RegionMarkDraft | null }) {
	const t = useT();
	const viewport = usePreviewViewport();
	const canvasSize = useEditor(
		(e) => e.project.getActiveOrNull()?.settings.canvasSize,
	);
	const canvasRects = useUserMarksStore((s) => s.canvasRects);
	const removeCanvasRect = useUserMarksStore((s) => s.removeCanvasRect);

	if (!canvasSize) {
		return null;
	}

	const toOverlayBox = (
		leftPx: number,
		topPx: number,
		rightPx: number,
		bottomPx: number,
	): OverlayBox => {
		const p1 = viewport.canvasToOverlay({ canvasX: leftPx, canvasY: topPx });
		const p2 = viewport.canvasToOverlay({ canvasX: rightPx, canvasY: bottomPx });
		return {
			left: p1.x,
			top: p1.y,
			width: p2.x - p1.x,
			height: p2.y - p1.y,
		};
	};

	const markBoxes = canvasRects.map((rect: CanvasRectMark) => ({
		id: rect.id,
		box: toOverlayBox(
			rect.left * canvasSize.width,
			rect.top * canvasSize.height,
			rect.right * canvasSize.width,
			rect.bottom * canvasSize.height,
		),
	}));

	let draftBox: OverlayBox | null = null;
	if (draft) {
		draftBox = toOverlayBox(
			Math.min(draft.x0, draft.x1),
			Math.min(draft.y0, draft.y1),
			Math.max(draft.x0, draft.x1),
			Math.max(draft.y0, draft.y1),
		);
	}

	return (
		<div className="pointer-events-none absolute inset-0">
			{markBoxes.map(({ id, box }) => (
				<div
					key={id}
					className="border-primary/60 bg-primary/10 absolute border-2"
					style={{
						left: box.left,
						top: box.top,
						width: box.width,
						height: box.height,
					}}
				>
					<span className="bg-background text-foreground pointer-events-none absolute top-0.5 left-0.5 flex size-4 items-center justify-center rounded-sm border text-[10px] leading-none font-medium">
						{id}
					</span>
					<button
						type="button"
						aria-label={t("shell.clearRegionMark")}
						title={t("shell.clearRegionMark")}
						className="bg-background text-foreground pointer-events-auto absolute top-0.5 right-0.5 flex size-4 cursor-pointer items-center justify-center rounded-sm border"
						onClick={() => removeCanvasRect(id)}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
					</button>
				</div>
			))}
			{draftBox && (
				<div
					className="border-primary/40 bg-primary/5 absolute border-2"
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

"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FrameRate } from "opencut-wasm";
import { useEditor } from "@/editor/use-editor";
import { frameRateToFloat } from "@/fps/utils";
import {
	useUserMarksStore,
	type CanvasRectMark,
} from "@/editor/user-marks-store";
import { useT } from "@/i18n";
import { cn } from "@/utils/ui";
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

/** Formats seconds as HH:MM:SS:FF, matching the playback timecode display. */
function formatTimecode({
	timeInSeconds,
	fps,
}: {
	timeInSeconds: number;
	fps: FrameRate;
}): string {
	const fpsFloat = frameRateToFloat(fps);
	const fpsInt = Math.round(fpsFloat);
	const totalFrames = Math.max(0, Math.round(timeInSeconds * fpsFloat));
	const totalSeconds = Math.floor(totalFrames / fpsFloat);
	const p = (n: number) => n.toString().padStart(2, "0");
	return `${p(Math.floor(totalSeconds / 3600))}:${p(
		Math.floor(totalSeconds / 60) % 60,
	)}:${p(totalSeconds % 60)}:${p(totalFrames % fpsInt)}`;
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
	const fps = useEditor((e) => e.project.getActiveOrNull()?.settings.fps);
	const canvasRects = useUserMarksStore((s) => s.canvasRects);
	const removeCanvasRect = useUserMarksStore((s) => s.removeCanvasRect);

	if (!canvasSize || !fps) {
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
		time: rect.time,
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
			{markBoxes.map(({ id, time, box }) => (
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
					{/* Narrow rects can't fit the label inside — push it out to
						the left of the rect instead of letting it overlap. */}
					<span
						className={cn(
							"bg-background text-foreground pointer-events-none absolute top-0.5 flex h-4 min-w-4 items-center justify-center rounded-sm border px-0.5 text-[10px] leading-none font-medium",
							box.width >= 36 ? "left-0.5" : "-left-5",
						)}
					>
						{id}
					</span>
					{/* Timecode above the rect's top-left corner; flips below when
						the rect hugs the top edge so it never gets clipped. */}
					<span
						className="bg-muted text-muted-foreground pointer-events-none absolute left-0 flex h-4 items-center whitespace-nowrap rounded-sm border px-0.5 text-[10px] leading-none font-medium"
						style={
							box.top < 18
								? { top: "100%", marginTop: 2 }
								: { bottom: "100%", marginBottom: 2 }
						}
					>
						{formatTimecode({ timeInSeconds: time, fps })}
					</span>
					<button
						type="button"
						aria-label={t("shell.clearRegionMark")}
						title={t("shell.clearRegionMark")}
						className={cn(
							"bg-background text-foreground pointer-events-auto absolute top-0.5 flex size-4 cursor-pointer items-center justify-center rounded-sm border",
							box.width >= 36 ? "right-0.5" : "-right-5",
						)}
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

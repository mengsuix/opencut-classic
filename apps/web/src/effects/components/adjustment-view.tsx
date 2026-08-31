"use client";

import { useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { EffectPreviewCanvas } from "./assets-view";
import { useEditor } from "@/editor/use-editor";
import { useT } from "@/i18n";
import { buildEffectElement } from "@/timeline/element-utils";

const ADJUSTMENT_EFFECT_TYPE = "color-adjust";

export function AdjustmentView() {
	const t = useT();
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: ADJUSTMENT_EFFECT_TYPE,
			startTime: currentTime,
		});
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor]);

	return (
		<PanelView title={t("assets.tabAdjustment")}>
			<p className="text-muted-foreground mb-3 text-sm">
				{t("assets.adjustmentHint")}
			</p>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
			>
				<DraggableItem
					name={t("assets.adjustmentCustom")}
					preview={<EffectPreviewCanvas effectType={ADJUSTMENT_EFFECT_TYPE} />}
					dragData={{
						id: ADJUSTMENT_EFFECT_TYPE,
						name: t("assets.adjustmentCustom"),
						type: "effect",
						effectType: ADJUSTMENT_EFFECT_TYPE,
						targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
					}}
					onAddToTimeline={handleAddToTimeline}
					aspectRatio={1}
					isRounded
					variant="card"
					containerClassName="w-full"
				/>
			</div>
		</PanelView>
	);
}

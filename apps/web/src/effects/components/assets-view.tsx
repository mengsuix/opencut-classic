"use client";

import { useEffect, useRef, useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useEditor } from "@/editor/use-editor";
import { useT } from "@/i18n";
import { buildEffectElement } from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import type { CreateTimelineElement } from "@/timeline";
import type { HtmlPreset } from "@/project/types";
import type { EffectDefinition } from "@/effects/types";

export function EffectsView() {
	const t = useT();
	const effects = effectsRegistry.getAll();

	return (
		<PanelView title={t("properties.tabEffects")}>
			<EffectsGrid effects={effects} />
			<HtmlPresetsSection />
		</PanelView>
	);
}

/** Saved live-HTML effects of this project: click to drop a copy at the playhead. */
function HtmlPresetsSection() {
	const t = useT();
	const editor = useEditor();
	const presets = useEditor((e) => e.project.getHtmlPresets());

	const insertPreset = (preset: HtmlPreset) => {
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "graphic" },
			element: {
				type: "html",
				name: preset.name,
				html: preset.html,
				params: { ...preset.params },
				intrinsicWidth: preset.intrinsicWidth,
				intrinsicHeight: preset.intrinsicHeight,
				startTime: editor.playback.getCurrentTime(),
				duration: DEFAULT_NEW_ELEMENT_DURATION,
			} as CreateTimelineElement,
		});
	};

	const removePreset = (presetId: string) => {
		editor.project.setHtmlPresets({
			presets: presets.filter((preset) => preset.id !== presetId),
		});
	};

	return (
		<div className="mt-4 flex flex-col gap-2">
			<span className="text-muted-foreground text-xs">
				{t("assets.htmlPresets")}
			</span>
			{presets.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					{t("assets.htmlPresetsEmpty")}
				</p>
			) : (
				<div className="flex flex-col gap-1">
					{presets.map((preset) => (
						<div key={preset.id} className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => insertPreset(preset)}
								className="bg-secondary text-secondary-foreground hover:bg-secondary/80 flex-1 truncate rounded-sm px-2 py-1.5 text-left text-xs"
							>
								{preset.name}
							</button>
							<button
								type="button"
								onClick={() => removePreset(preset.id)}
								className="text-muted-foreground hover:text-foreground px-1 text-xs"
							>
								✕
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function EffectsGrid({ effects }: { effects: EffectDefinition[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{effects.map((effect) => (
				<EffectItem key={effect.type} effect={effect} />
			))}
		</div>
	);
}

export function EffectPreviewCanvas({ effectType }: { effectType: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType,
					params: {},
					targetCanvas: canvasRef.current,
				});
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effectType]);

	return <canvas ref={canvasRef} className="size-full" />;
}

function EffectItem({ effect }: { effect: EffectDefinition }) {
	useT();
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: effect.type,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, effect.type]);

	const preview = <EffectPreviewCanvas effectType={effect.type} />;

	return (
		<DraggableItem
			name={effect.name}
			preview={preview}
			dragData={{
				id: effect.type,
				name: effect.name,
				type: "effect",
				effectType: effect.type,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}

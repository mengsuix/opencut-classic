import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { useT } from "@/i18n";
import { DEFAULTS } from "@/timeline/defaults";
import { buildTextElement } from "@/timeline/element-utils";
import type { ParamValues } from "@/params";
import { TEXT_PRESETS, type TextPreset } from "@/text/presets";
import type { MediaTime } from "@/wasm";

function buildPresetPreviewStyle({
	preset,
}: {
	preset: TextPreset;
}): React.CSSProperties {
	const params = preset.params;
	const style: React.CSSProperties = {};
	if (typeof params.color === "string") {
		style.color = params.color;
	}
	if (params.fontWeight === "bold") {
		style.fontWeight = 700;
	}
	if (params["stroke.enabled"] === true && typeof params["stroke.color"] === "string") {
		const strokeColor = params["stroke.color"];
		style.textShadow = `-1px -1px 0 ${strokeColor}, 1px -1px 0 ${strokeColor}, -1px 1px 0 ${strokeColor}, 1px 1px 0 ${strokeColor}, 0 -1px 0 ${strokeColor}, 0 1px 0 ${strokeColor}, -1px 0 0 ${strokeColor}, 1px 0 0 ${strokeColor}`;
	}
	if (params["shadow.enabled"] === true && typeof params["shadow.color"] === "string") {
		style.textShadow = `0 2px 4px ${params["shadow.color"]}`;
	}
	if (params["gradient.enabled"] === true && typeof params["gradient.color"] === "string") {
		style.backgroundImage = `linear-gradient(180deg, ${typeof params.color === "string" ? params.color : "#ffffff"}, ${params["gradient.color"]})`;
		style.backgroundClip = "text";
		style.WebkitBackgroundClip = "text";
		style.WebkitTextFillColor = "transparent";
	}
	if (params["background.enabled"] === true && typeof params["background.color"] === "string") {
		style.backgroundColor = params["background.color"];
		style.borderRadius = 4;
		style.padding = "2px 6px";
	}
	return style;
}

export function TextView() {
	const t = useT();
	const editor = useEditor();

	const handleAddToTimeline = ({
		currentTime,
		params,
	}: {
		currentTime: MediaTime;
		params?: ParamValues;
	}) => {
		const activeScene = editor.scenes.getActiveScene();
		if (!activeScene) return;

		const element = buildTextElement({
			raw: {
				...DEFAULTS.text.element,
				params: { ...DEFAULTS.text.element.params, ...(params ?? {}) },
			},
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<PanelView title={t("assets.textPanelTitle")}>
			<div className="grid grid-cols-2 gap-2">
				<DraggableItem
					name={t("assets.defaultText")}
					preview={
						<div className="bg-accent flex size-full items-center justify-center rounded">
							<span className="text-xs select-none">{t("assets.defaultText")}</span>
						</div>
					}
					dragData={{
						id: "temp-text-id",
						type: DEFAULTS.text.element.type,
						name: DEFAULTS.text.element.name,
						content: t("assets.defaultText"),
					}}
					aspectRatio={1}
					onAddToTimeline={({ currentTime }) =>
						handleAddToTimeline({ currentTime })
					}
					shouldShowLabel={false}
				/>
				<div className="col-span-full mt-1 text-xs text-muted-foreground select-none">
					{t("assets.textPresets")}
				</div>
				{TEXT_PRESETS.map((preset) => (
					<DraggableItem
						key={preset.key}
						name={preset.name}
						preview={
							<div className="bg-accent flex size-full items-center justify-center rounded">
								<span
									className="text-xs select-none"
									style={buildPresetPreviewStyle({ preset })}
								>
									{preset.name}
								</span>
							</div>
						}
						dragData={{
							id: `temp-text-preset-${preset.key}`,
							type: DEFAULTS.text.element.type,
							name: preset.name,
							content: t("assets.defaultText"),
							params: preset.params,
						}}
						aspectRatio={1}
						onAddToTimeline={({ currentTime }) =>
							handleAddToTimeline({ currentTime, params: preset.params })
						}
						shouldShowLabel={false}
					/>
				))}
			</div>
		</PanelView>
	);
}

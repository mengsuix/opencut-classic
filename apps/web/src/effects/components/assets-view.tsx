"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Code, Plus, X } from "lucide-react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { MediaPreview } from "@/components/editor/panels/assets/views/assets";
import { AspectRatio } from "@/components/ui/aspect-ratio";
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
import { Button } from "@/components/ui/button";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { loadHtmlSource } from "@/services/renderer/nodes/html-node";
import { useEditor } from "@/editor/use-editor";
import { useT } from "@/i18n";
import { invokeAction } from "@/actions";
import { buildRemoveHtmlPresetCommand } from "@/commands";
import { collectHtmlPresetInstances } from "@/timeline/element-utils";
import {
	buildEffectElement,
	buildElementFromMedia,
} from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { MASKABLE_ELEMENT_TYPES } from "@/timeline";
import type { CreateTimelineElement } from "@/timeline";
import type { HtmlPreset } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import type { EffectDefinition } from "@/effects/types";

export function EffectsView() {
	const t = useT();
	const effects = effectsRegistry.getAll();

	return (
		<PanelView title={t("properties.tabEffects")}>
			<GeneratedFxSection />
			<div className="mt-4 flex flex-col gap-2">
				<span className="text-muted-foreground text-xs">
					{t("assets.builtinEffects")}
				</span>
				<EffectsGrid effects={effects} />
			</div>
		</PanelView>
	);
}

/**
 * Agent output shelf: HTML presets (auto-saved by timeline.add_html) and
 * rendered fx media assets (media.import ephemeral=true, hidden from the
 * media panel). Click the plus button to drop a copy at the playhead.
 */
function GeneratedFxSection() {
	const t = useT();
	const presets = useEditor((e) => e.project.getHtmlPresets());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const fxMedia = mediaAssets.filter((item) => item.ephemeral);

	return (
		<div className="flex flex-col gap-2">
			<span className="text-muted-foreground text-xs">
				{t("assets.generatedFx")}
			</span>
			{presets.length === 0 && fxMedia.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					{t("assets.generatedFxEmpty")}
				</p>
			) : (
				<div
					className="grid gap-2"
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
					}}
				>
					{presets.map((preset) => (
						<HtmlPresetItem key={preset.id} preset={preset} />
					))}
					{fxMedia.map((asset) => (
						<GeneratedMediaItem key={asset.id} asset={asset} />
					))}
				</div>
			)}
		</div>
	);
}

function ItemButton({
	className,
	title,
	onClick,
	children,
}: {
	className?: string;
	title?: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Button
			size="icon"
			className={className}
			title={title}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onClick();
			}}
		>
			{children}
		</Button>
	);
}

const ITEM_BUTTON_CLASS =
	"bg-background hover:bg-background text-foreground absolute size-5 opacity-0 group-hover:opacity-100";

function HtmlPresetItem({ preset }: { preset: HtmlPreset }) {
	const t = useT();
	const editor = useEditor();
	const [usedInstanceCount, setUsedInstanceCount] = useState<number | null>(
		null,
	);

	const insertPreset = () => {
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "graphic" },
			element: {
				type: "html",
				name: preset.name,
				html: preset.html,
				presetId: preset.id,
				params: { ...preset.params },
				intrinsicWidth: preset.intrinsicWidth,
				intrinsicHeight: preset.intrinsicHeight,
				startTime: editor.playback.getCurrentTime(),
				duration: DEFAULT_NEW_ELEMENT_DURATION,
			} as CreateTimelineElement,
		});
	};

	const removePresetWithInstances = () => {
		const { command } = buildRemoveHtmlPresetCommand({
			tracks: editor.scenes.getActiveScene().tracks,
			presetId: preset.id,
		});
		editor.command.execute({ command });
	};

	const handleRemoveClick = () => {
		const instances = collectHtmlPresetInstances({
			tracks: editor.scenes.getActiveScene().tracks,
			presetId: preset.id,
		});
		if (instances.length === 0) {
			removePresetWithInstances();
			return;
		}
		setUsedInstanceCount(instances.length);
	};

	return (
		<>
			<div className="group relative w-full">
				<div className="relative flex h-auto w-full flex-col gap-1">
					<AspectRatio
						ratio={16 / 9}
						className="bg-accent relative overflow-hidden rounded-sm"
					>
						<HtmlPresetPreview preset={preset} />
						<ItemButton
							className={`${ITEM_BUTTON_CLASS} right-2 bottom-2`}
							title={t("assets.addToTimelineOrDrag")}
							onClick={insertPreset}
						>
							<Plus />
						</ItemButton>
						<ItemButton
							className={`${ITEM_BUTTON_CLASS} top-2 right-2`}
							title={t("common.delete")}
							onClick={handleRemoveClick}
						>
							<X />
						</ItemButton>
					</AspectRatio>
					<span
						className="text-muted-foreground w-full truncate text-left text-[0.7rem]"
						title={preset.name}
					>
						{preset.name}
					</span>
				</div>
			</div>
			<AlertDialog
				open={usedInstanceCount !== null}
				onOpenChange={(open) => {
					if (!open) setUsedInstanceCount(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("assets.removeFxUsedTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("assets.removeFxUsedDescription", {
								name: preset.name,
								count: usedInstanceCount ?? 0,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setUsedInstanceCount(null);
								removePresetWithInstances();
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

/** Rasterized first impression of an HTML preset, sharing the renderer cache. */
function HtmlPresetPreview({ preset }: { preset: HtmlPreset }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [failed, setFailed] = useState(false);

	// Presets are immutable snapshots (html.update never touches them), so the
	// effect runs once per mounted preset and `failed` needs no reset.
	useEffect(() => {
		let cancelled = false;
		loadHtmlSource({
			html: preset.html,
			params: preset.params ?? {},
			width: preset.intrinsicWidth,
			height: preset.intrinsicHeight,
			// Static HTML ignores `seconds`; animated/scripted HTML is shown past
			// the intro so the thumbnail is not a blank t=0 frame.
			seconds: 0.5,
		})
			.then(({ source, width, height }) => {
				if (cancelled || !canvasRef.current) return;
				const scale = Math.min(1, 320 / Math.max(width, height));
				const w = Math.max(1, Math.round(width * scale));
				const h = Math.max(1, Math.round(height * scale));
				const canvas = canvasRef.current;
				canvas.width = w;
				canvas.height = h;
				canvas.getContext("2d")?.drawImage(source, 0, 0, w, h);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [preset]);

	if (failed) {
		return (
			<div className="text-muted-foreground flex size-full items-center justify-center">
				<Code className="size-6" />
			</div>
		);
	}
	return <canvas ref={canvasRef} className="size-full object-contain" />;
}

function GeneratedMediaItem({ asset }: { asset: MediaAsset }) {
	const t = useT();
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());

	const addToTimeline = ({ currentTime }: { currentTime: MediaTime }) => {
		const duration =
			asset.duration != null
				? mediaTimeFromSeconds({ seconds: asset.duration })
				: DEFAULT_NEW_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime: currentTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	const removeAsset = () => {
		invokeAction("remove-media-assets", {
			projectId: activeProject.metadata.id,
			assetIds: [asset.id],
		});
	};

	return (
		<div className="group relative">
			<DraggableItem
				name={asset.name}
				preview={<MediaPreview item={asset} variant="grid" />}
				dragData={{
					id: asset.id,
					type: "media",
					mediaType: asset.type,
					name: asset.name,
					...(asset.type !== "audio" && {
						targetElementTypes: [...MASKABLE_ELEMENT_TYPES],
					}),
				}}
				shouldShowPlusOnDrag={false}
				onAddToTimeline={addToTimeline}
				variant="card"
				isRounded
				containerClassName="w-full"
			/>
			<ItemButton
				className={`${ITEM_BUTTON_CLASS} top-2 right-2`}
				title={t("common.delete")}
				onClick={removeAsset}
			>
				<X />
			</ItemButton>
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

"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { useT } from "@/i18n";
import { findTrackInSceneTracks } from "@/timeline";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { TRANSITION_TYPES, type TransitionType } from "@/timeline/transition";
import { cn } from "@/utils/ui";

const TRANSITION_KEYS = TRANSITION_TYPES.filter((type) => type !== "none");

const TRANSITION_LABEL_KEYS = {
	none: "properties.transitionNone",
	fade: "properties.transitionFade",
	black: "properties.transitionBlack",
	zoom: "properties.transitionZoom",
	"slide-left": "properties.transitionSlideLeft",
	"slide-right": "properties.transitionSlideRight",
} as const;

export function TransitionsView() {
	const t = useT();
	const editor = useEditor();
	const tracks = useEditor((e) => e.timeline.getPreviewTracks());
	const { selectedElements } = useElementSelection();

	const selectedRef =
		selectedElements.length === 1 ? selectedElements[0] : null;
	const track =
		selectedRef && tracks
			? findTrackInSceneTracks({ tracks, trackId: selectedRef.trackId })
			: null;
	const element =
		track?.elements.find(
			(candidate) => candidate.id === selectedRef?.elementId,
		) ?? null;
	const canApply = element?.type === "video" || element?.type === "image";
	const rawActiveType = canApply ? element.params["transition.type"] : null;
	const activeType =
		TRANSITION_TYPES.find((known) => known === rawActiveType) ?? "none";

	const handleApply = ({ type }: { type: TransitionType }) => {
		if (!canApply || !selectedRef) return;
		const nextType = activeType === type ? "none" : type;
		editor.timeline.updateElements({
			updates: [
				{
					trackId: selectedRef.trackId,
					elementId: selectedRef.elementId,
					patch: { params: { "transition.type": nextType } },
				},
			],
		});
	};

	return (
		<PanelView title={t("assets.tabTransitions")}>
			{!canApply && (
				<p className="text-muted-foreground mb-3 text-sm">
					{t("assets.transitionSelectHint")}
				</p>
			)}
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
			>
				{TRANSITION_KEYS.map((type) => (
					<TransitionCard
						key={type}
						type={type}
						label={t(TRANSITION_LABEL_KEYS[type])}
						isActive={activeType === type}
						disabled={!canApply}
						onClick={() => handleApply({ type })}
					/>
				))}
			</div>
		</PanelView>
	);
}

function TransitionCard({
	type,
	label,
	isActive,
	disabled,
	onClick,
}: {
	type: TransitionType;
	label: string;
	isActive: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"hover:bg-accent flex flex-col items-center gap-1.5 rounded-md border p-2 transition-colors",
				isActive ? "border-primary" : "border-transparent",
				disabled && "pointer-events-none opacity-50",
			)}
		>
			<TransitionPreview type={type} />
			<span className="text-xs">{label}</span>
		</button>
	);
}

function TransitionPreview({ type }: { type: TransitionType }) {
	return (
		<div className="bg-muted relative h-10 w-full overflow-hidden rounded-sm">
			<div className="absolute inset-y-0 left-0 w-1/2 bg-sky-600" />
			<div
				className={cn(
					"absolute inset-y-0 right-0 w-1/2 bg-amber-500",
					type === "fade" && "opacity-60",
					type === "zoom" && "scale-110",
					type === "slide-left" && "-translate-x-2",
					type === "slide-right" && "translate-x-2",
				)}
			/>
			{type === "fade" && (
				<div className="absolute inset-y-0 left-1/3 w-1/3 bg-gradient-to-r from-sky-600 to-amber-500" />
			)}
			{type === "black" && (
				<div className="absolute inset-y-0 left-1/3 w-1/3 bg-black" />
			)}
			{type === "zoom" && (
				<div className="absolute inset-y-0 left-1/3 w-1/3 bg-amber-500/50" />
			)}
		</div>
	);
}

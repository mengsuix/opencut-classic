"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Check, ListCheck, Plus, Trash2 } from "lucide-react";
import { cn } from "@/utils/ui";
import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	DialogTrigger,
} from "@/components/ui/dialog";
import { canDeleteScene, getMainScene } from "@/timeline/scenes";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { getLocale, useT } from "@/i18n";

function toChineseNumeral(value: number): string {
	const digits = "零一二三四五六七八九";
	const units = ["", "十", "百", "千"];
	if (value >= 10000) return String(value);

	const numbers = String(value).split("").map(Number);
	let result = "";
	let pendingZero = false;
	for (const [index, digit] of numbers.entries()) {
		const unit = units[numbers.length - index - 1];
		if (digit === 0) {
			pendingZero = result.length > 0;
			continue;
		}
		if (pendingZero) result += "零";
		if (digit !== 1 || unit !== "十" || result.length > 0) {
			result += digits[digit];
		}
		result += unit;
		pendingZero = false;
	}
	return result;
}

export function ScenesView({ children }: { children: React.ReactNode }) {
	const t = useT();
	const editor = useEditor();
	const scenes = editor.scenes.getScenes();
	const currentScene = editor.scenes.getActiveScene();
	const [isSelectMode, setIsSelectMode] = useState(false);
	const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());

	const handleSceneSwitch = async (sceneId: string) => {
		if (isSelectMode) {
			toggleSceneSelection({ sceneId });
			return;
		}

		try {
			await editor.scenes.switchToScene({ sceneId });
		} catch (error) {
			console.error("Failed to switch scene:", error);
		}
	};

	const toggleSceneSelection = ({ sceneId }: { sceneId: string }) => {
		setSelectedScenes((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(sceneId)) {
				newSet.delete(sceneId);
			} else {
				newSet.add(sceneId);
			}
			return newSet;
		});
	};

	const handleSelectMode = () => {
		setIsSelectMode(!isSelectMode);
		setSelectedScenes(new Set());
	};

	const handleCreateScene = async () => {
		try {
			const count = scenes.length + 1;
			const sceneId = await editor.scenes.createScene({
				name: t("scenes.newName", {
					count: getLocale() === "zh" ? toChineseNumeral(count) : count,
				}),
				isMain: false,
			});
			await editor.scenes.switchToScene({ sceneId });
		} catch (error) {
			console.error("Failed to create scene:", error);
			toast.error(t("scenes.createFailed"));
		}
	};

	const handleDeleteSelected = async () => {
		for (const sceneId of selectedScenes) {
			const scene = scenes.find((scene) => scene.id === sceneId);
			if (!scene) {
				continue;
			}

			const { canDelete, reason } = canDeleteScene({ scene });
			if (!canDelete) {
				toast.error(reason || t("scenes.deleteFailed"));
				continue;
			}

			try {
				await editor.scenes.deleteScene({ sceneId });
			} catch (error) {
				console.error("Failed to delete scene:", error);
			}
		}
		setSelectedScenes(new Set());
		setIsSelectMode(false);
	};

	const isMainSceneSelected = (() => {
		const mainScene = getMainScene({ scenes });
		return Boolean(mainScene?.id && selectedScenes.has(mainScene.id));
	})();

	return (
		<Sheet>
			<SheetTrigger asChild>{children}</SheetTrigger>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>
						{isSelectMode
							? t("scenes.selectTitle", { count: selectedScenes.size })
							: t("scenes.title")}
					</SheetTitle>
					<SheetDescription>
						{isSelectMode
							? t("scenes.selectDescription")
							: t("scenes.description")}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-4 py-4">
					<div className="flex items-center gap-2">
						<Button
							className="rounded-md"
							variant="outline"
							size="sm"
							onClick={handleCreateScene}
							disabled={isSelectMode}
						>
							<Plus />
							{t("scenes.create")}
						</Button>
						<Button
							className="rounded-md"
							variant={isSelectMode ? "default" : "outline"}
							size="sm"
							onClick={handleSelectMode}
						>
							<ListCheck />
							{isSelectMode ? t("common.cancel") : t("scenes.select")}
							</Button>
						{isSelectMode && (
							<DeleteDialog
								count={selectedScenes.size}
								onDelete={handleDeleteSelected}
								disabled={selectedScenes.size === 0 || isMainSceneSelected}
								trigger={
									<Button
										className="rounded-md"
										variant="destructive"
										disabled={selectedScenes.size === 0 || isMainSceneSelected}
										size="sm"
									>
										<Trash2 />
										{t("scenes.deleteCount", { count: selectedScenes.size })}
										</Button>
								}
							/>
						)}
					</div>
					{scenes.length === 0 ? (
						<div className="text-muted-foreground text-sm">
							{t("scenes.empty")}
						</div>
					) : (
						<div className="space-y-2">
							{scenes.map((scene) => (
								<Button
									key={scene.id}
									variant="outline"
									className={cn(
										"w-full justify-between font-normal",
										currentScene?.id === scene.id &&
											!isSelectMode &&
											"border-primary !text-primary",
										isSelectMode &&
											selectedScenes.has(scene.id) &&
											"bg-accent border-foreground/30",
									)}
									onClick={() => handleSceneSwitch(scene.id)}
									disabled={isSelectMode && scene.isMain}
								>
									<span>
										{scene.isMain ? t("timeline.mainScene") : scene.name}
									</span>
									<div className="flex items-center gap-2">
										{((isSelectMode && selectedScenes.has(scene.id)) ||
											(!isSelectMode && currentScene?.id === scene.id)) && (
											<Check className="size-4" />
										)}
									</div>
								</Button>
							))}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function DeleteDialog({
	count,
	onDelete,
	disabled,
	trigger,
}: {
	count: number;
	onDelete: () => void;
	disabled?: boolean;
	trigger: React.ReactNode;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);

	const handleDelete = () => {
		onDelete();
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("scenes.deleteTitle")}</DialogTitle>
					<DialogDescription>
						{t("scenes.deleteConfirm", { count })}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={disabled}
					>
						{t("common.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

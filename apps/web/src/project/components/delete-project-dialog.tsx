import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";

export function DeleteProjectDialog({
	isOpen,
	onOpenChange,
	onConfirm,
	projectNames,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	projectNames: string[];
}) {
	const t = useT();
	const count = projectNames.length;
	const isSingle = count === 1;
	const singleName = isSingle ? projectNames[0] : null;

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{singleName ? (
							<>
								{t("shell.deleteSinglePrefix")}
								<span className="inline-block max-w-[300px] truncate align-bottom">
									{singleName}
								</span>
								{t("shell.deleteSingleSuffix")}
							</>
						) : (
							t("shell.deleteMultipleTitle", { count })
						)}
					</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<Alert variant="destructive">
						<AlertTitle>{t("shell.deleteWarning")}</AlertTitle>
						<AlertDescription>
							{singleName
								? t("shell.deleteConfirmSingle", { name: singleName })
								: t("shell.deleteConfirmMultiple", { count })}
						</AlertDescription>
					</Alert>
					<div className="flex flex-col gap-3">
						<Label className="text-xs font-semibold text-slate-500">
							{t("shell.typeDeleteToConfirm")}
						</Label>
						<Input
							type="text"
							placeholder="DELETE"
							size="lg"
							variant="destructive"
						/>
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
					<Button variant="destructive" onClick={onConfirm}>
						{t("shell.deleteProject")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

"use client";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useStoragePersistence } from "@/services/storage/use-storage-persistence";
import { useT } from "@/i18n";

export function StoragePersistenceDialog() {
	const { showDialog, onConfirm, onDismiss } = useStoragePersistence();
	const t = useT();

	return (
		<Dialog open={showDialog} onOpenChange={(open) => !open && onDismiss()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("toasts.storageDialogTitle")}</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<p className="text-base text-muted-foreground">
						{t("toasts.storageDialogBody1")}
					</p>
					<p className="text-base text-muted-foreground">
						{t("toasts.storageDialogBody2")}
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={onDismiss}>
						{t("toasts.storageDialogNotNow")}
					</Button>
					<Button onClick={onConfirm}>{t("toasts.storageDialogAllow")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

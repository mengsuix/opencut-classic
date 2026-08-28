import { toast } from "sonner";
import { t } from "@/i18n";

export interface MediaUploadToastResult {
	uploadedCount: number;
	assetNames?: string[];
}

function getAssetLabel({ count }: { count: number }): string {
	return count === 1 ? t("toasts.mediaAsset") : t("toasts.mediaAssets");
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
}) {
	const run = typeof promise === "function" ? promise : () => promise;
	const toastPromise = toast.promise(async () => {
		await waitForNextPaint();
		return run();
	}, {
		loading: t("toasts.mediaUploading", {
			label: getAssetLabel({ count: filesCount }),
		}),
		success: ({ uploadedCount, assetNames }) => {
			if (uploadedCount === 1) {
				const assetName = assetNames?.[0];
				return assetName
					? t("toasts.mediaUploadedNamed", { name: assetName })
					: t("toasts.mediaUploadedSingle");
			}

			if (uploadedCount > 1) {
				return t("toasts.mediaUploadedMultiple", { count: uploadedCount });
			}

			return t("toasts.mediaUploadedNone");
		},
		error: t("toasts.mediaUploadFailed", {
			label: getAssetLabel({ count: filesCount }),
		}),
	});

	return toastPromise.unwrap();
}

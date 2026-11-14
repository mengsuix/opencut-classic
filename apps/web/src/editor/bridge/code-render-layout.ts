import { getSourceTimeAtClipTime } from "@/retime/resolve";
import type { ImageElement, VideoElement } from "@/timeline/types";
import { getCustomTransitionWindow } from "@/timeline/transition";
import { TICKS_PER_SECOND } from "@/wasm";

export function isSameSourceCut({
	outgoing,
	incoming,
}: {
	outgoing: VideoElement;
	incoming: VideoElement;
}): boolean {
	if (outgoing.mediaId !== incoming.mediaId) return false;
	const outgoingSourceEnd =
		outgoing.trimStart +
		getSourceTimeAtClipTime({
			clipTime: outgoing.duration,
			retime: outgoing.retime,
			animations: outgoing.animations,
		});
	return (
		Math.abs(incoming.trimStart - outgoingSourceEnd) < TICKS_PER_SECOND / 30
	);
}

export function resolveCodeTransitionLayout({
	outgoing,
	incoming,
	duration,
	layout = "auto",
}: {
	outgoing: VideoElement | ImageElement;
	incoming: VideoElement | ImageElement;
	duration: number;
	layout?: string;
}) {
	if (!["auto", "cut", "center", "split-center"].includes(layout)) {
		throw new Error("layout must be 'auto', 'cut', 'center' or 'split-center'");
	}
	const sameSourceCut =
		outgoing.type === "video" &&
		incoming.type === "video" &&
		isSameSourceCut({ outgoing, incoming });
	const resolvedLayout =
		layout === "auto"
			? sameSourceCut
				? "center"
				: "cut"
			: layout === "center" || layout === "split-center"
				? "center"
				: "cut";
	return {
		layout: resolvedLayout,
		...getCustomTransitionWindow({
			outgoingStartTime: outgoing.startTime,
			outgoingDuration: outgoing.duration,
			duration: duration * TICKS_PER_SECOND,
			layout: resolvedLayout,
		}),
	};
}

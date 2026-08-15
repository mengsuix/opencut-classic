import { useEffect, useState } from "react";
import { getVideoFilmstrip } from "./video-filmstrip";

// Trim/zoom drags change the inputs continuously; regenerating per pointer
// move would mean one full decode pass per move. Wait until they settle so a
// drag costs a single regeneration.
const REGEN_DEBOUNCE_MS = 300;

export function useVideoFilmstrip({
	mediaId,
	file,
	startTime,
	endTime,
	frameCount,
}: {
	mediaId: string;
	file: File | undefined;
	startTime: number;
	endTime: number;
	frameCount: number;
}): string[] {
	const [request, setRequest] = useState({ startTime, endTime, frameCount });

	useEffect(() => {
		// The first real measurement (frameCount 0 -> N) must not wait for the
		// debounce, or every newly added clip would show its fallback late.
		const firstMeasure = request.frameCount <= 0 && frameCount > 0;
		const id = setTimeout(
			() => {
				setRequest((prev) =>
					prev.startTime === startTime &&
					prev.endTime === endTime &&
					prev.frameCount === frameCount
						? prev
						: { startTime, endTime, frameCount },
				);
			},
			firstMeasure ? 0 : REGEN_DEBOUNCE_MS,
		);
		return () => clearTimeout(id);
	}, [startTime, endTime, frameCount, request.frameCount]);

	const requestKey = `${mediaId}:${request.startTime}:${request.endTime}:${request.frameCount}`;
	const [result, setResult] = useState<{
		key: string;
		frames: string[];
	}>({ key: "", frames: [] });

	useEffect(() => {
		if (
			!file ||
			request.frameCount <= 0 ||
			request.endTime <= request.startTime
		) {
			return;
		}

		let active = true;

		void getVideoFilmstrip({
			mediaId,
			file,
			startTime: request.startTime,
			endTime: request.endTime,
			frameCount: request.frameCount,
			onFrame: ({ index, url }) => {
				if (!active) {
					return;
				}
				setResult((prev) => {
					// First frame of a new generation: seed the new tile count from the
					// previous strip so tiles morph in place instead of flashing empty.
					const base =
						prev.key === requestKey
							? prev.frames
							: resampleFrames({
									frames: prev.frames,
									count: request.frameCount,
								});
					const frames = [...base];
					frames[index] = url;
					return { key: requestKey, frames };
				});
			},
		}).then((frames) => {
			if (active) {
				setResult({ key: requestKey, frames });
			}
		});

		return () => {
			active = false;
		};
	}, [mediaId, file, request, requestKey]);

	return result.frames;
}

function resampleFrames({
	frames,
	count,
}: {
	frames: string[];
	count: number;
}): string[] {
	if (frames.length === 0) {
		return new Array(count).fill("");
	}
	return Array.from(
		{ length: count },
		(_, index) =>
			frames[
				Math.min(frames.length - 1, Math.floor((index * frames.length) / count))
			],
	);
}

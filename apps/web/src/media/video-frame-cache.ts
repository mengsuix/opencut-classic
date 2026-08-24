import {
	ALL_FORMATS,
	BlobSource,
	Input,
	VideoSampleSink,
} from "mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";

/**
 * Cache granularity in seconds. Requested timestamps are rounded to this grid
 * so that scrolling a few pixels reuses the frames already decoded instead of
 * producing brand-new cache keys.
 */
const FRAME_QUANTIZE_SECONDS = 0.5;

/**
 * Individual frames are ~15KB JPEG data URLs, so this bounds the cache at
 * roughly 15MB. Keying per frame (rather than per strip) is what makes windowed
 * filmstrips viable: panning back over an already-visited region is a pure cache
 * hit, while only genuinely new regions pay for a decode.
 */
const MAX_CACHED_FRAMES = 1000;

/** Serializes decoding per media file; parallel Input instances thrash the demuxer. */
const decodeQueues = new Map<string, Promise<unknown>>();

type CachedFrame = {
	promise: Promise<string>;
};

// Map insertion order = LRU order.
const frameCache = new Map<string, CachedFrame>();

export function quantizeFrameTime({ time }: { time: number }): number {
	return Math.round(time / FRAME_QUANTIZE_SECONDS) * FRAME_QUANTIZE_SECONDS;
}

function buildFrameKey({
	mediaId,
	quantizedTime,
}: {
	mediaId: string;
	quantizedTime: number;
}): string {
	return `${mediaId}@${quantizedTime.toFixed(3)}`;
}

function touch({ key, entry }: { key: string; entry: CachedFrame }): void {
	frameCache.delete(key);
	frameCache.set(key, entry);
}

function evictIfNeeded(): void {
	while (frameCache.size > MAX_CACHED_FRAMES) {
		const oldestKey = frameCache.keys().next().value;
		if (!oldestKey) break;
		frameCache.delete(oldestKey);
	}
}

/** Runs `task` after any in-flight decode for the same media file. */
function enqueue<T>({
	mediaId,
	task,
}: {
	mediaId: string;
	task: () => Promise<T>;
}): Promise<T> {
	const previous = decodeQueues.get(mediaId) ?? Promise.resolve();
	const next = previous.then(task, task);
	decodeQueues.set(
		mediaId,
		next.catch(() => {}),
	);
	return next;
}

async function decodeFrames({
	file,
	timestamps,
}: {
	file: File;
	timestamps: number[];
}): Promise<Array<string | null>> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack || !(await videoTrack.canDecode())) {
			return timestamps.map(() => null);
		}

		const sink = new VideoSampleSink(videoTrack);
		const results: Array<string | null> = timestamps.map(() => null);
		let index = 0;

		for await (const frame of sink.samplesAtTimestamps(timestamps)) {
			const frameIndex = index++;
			if (frameIndex >= timestamps.length) break;
			if (!frame) continue;

			try {
				results[frameIndex] = renderThumbnailDataUrl({
					width: videoTrack.displayWidth,
					height: videoTrack.displayHeight,
					maxWidth: 320,
					maxHeight: 180,
					draw: ({ context, width, height }) => {
						frame.draw(context, 0, 0, width, height);
					},
				});
			} finally {
				frame.close();
			}
		}

		return results;
	} finally {
		input.dispose();
	}
}

/**
 * Resolves the thumbnails for `times` (seconds into the source), decoding only
 * the ones that are not cached. Individual entries resolve to "" when the frame
 * could not be decoded.
 */
export function getVideoFrames({
	mediaId,
	file,
	times,
}: {
	mediaId: string;
	file: File;
	times: number[];
}): Promise<string>[] {
	const missing: Array<{ key: string; time: number }> = [];
	const pending = new Map<string, (url: string) => void>();

	const results = times.map((time) => {
		const quantizedTime = Math.max(0, quantizeFrameTime({ time }));
		const key = buildFrameKey({ mediaId, quantizedTime });

		// Covers both resolved frames and ones already queued in this batch,
		// since queued entries are inserted below before the loop continues.
		const cached = frameCache.get(key);
		if (cached) {
			touch({ key, entry: cached });
			return cached.promise;
		}

		const promise = new Promise<string>((resolve) => {
			pending.set(key, resolve);
		});
		const entry: CachedFrame = { promise };
		frameCache.set(key, entry);
		missing.push({ key, time: quantizedTime });
		return promise;
	});

	if (missing.length > 0) {
		void enqueue({
			mediaId,
			task: () =>
				decodeFrames({ file, timestamps: missing.map((item) => item.time) }),
		})
			.then((frames) => {
				missing.forEach((item, index) => {
					const url = frames[index] ?? "";
					if (!url) {
						// Don't cache failures — a later attempt may succeed once the
						// source is fully buffered.
						frameCache.delete(item.key);
					}
					pending.get(item.key)?.(url);
				});
			})
			.catch((error) => {
				console.warn("Failed to decode filmstrip frames", error);
				for (const item of missing) {
					frameCache.delete(item.key);
					pending.get(item.key)?.("");
				}
			})
			.finally(() => {
				evictIfNeeded();
			});
	}

	return results;
}

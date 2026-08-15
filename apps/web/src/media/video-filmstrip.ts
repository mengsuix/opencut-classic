import {
	ALL_FORMATS,
	BlobSource,
	Input,
	VideoSampleSink,
} from "mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";

const DEFAULT_FRAME_COUNT = 12;
// Entries hold 12-32 rendered dataURLs each; cap so zooming/trimming across
// many clips can't grow memory without bound. Map insertion order = LRU order.
const MAX_CACHE_ENTRIES = 40;

type FilmstripCacheEntry = {
	promise: Promise<string[]>;
};

const filmstripCache = new Map<string, FilmstripCacheEntry>();

function buildCacheKey({
	mediaId,
	startTime,
	endTime,
	frameCount,
}: {
	mediaId: string;
	startTime: number;
	endTime: number;
	frameCount: number;
}): string {
	return `${mediaId}:${startTime}:${endTime}:${frameCount}`;
}

async function generateVideoFilmstrip({
	file,
	startTime,
	endTime,
	frameCount = DEFAULT_FRAME_COUNT,
	onFrame,
}: {
	file: File;
	startTime: number;
	endTime: number;
	frameCount?: number;
	onFrame?: ({ index, url }: { index: number; url: string }) => void;
}): Promise<string[]> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack || !(await videoTrack.canDecode())) {
			return [];
		}

		const duration = Math.max(0, endTime - startTime);
		// Sample each tile's midpoint: the end boundary is the first trimmed-away
		// frame (or past the source end), so sampling exactly at it would either
		// show out-of-range content or yield null and shift the whole strip.
		const timestamps = Array.from({ length: frameCount }, (_, index) => {
			return startTime + (duration * (index + 0.5)) / frameCount;
		});
		const sink = new VideoSampleSink(videoTrack);
		// Fixed-length so a null sample keeps its tile empty instead of shifting
		// every later frame one slot to the left.
		const frames: string[] = new Array(frameCount).fill("");
		let index = 0;

		for await (const frame of sink.samplesAtTimestamps(timestamps)) {
			const frameIndex = index++;
			if (frameIndex >= frameCount) {
				break;
			}
			if (frame) {
				try {
					const url = renderThumbnailDataUrl({
						width: videoTrack.displayWidth,
						height: videoTrack.displayHeight,
						maxWidth: 320,
						maxHeight: 180,
						draw: ({ context, width, height }) => {
							frame.draw(context, 0, 0, width, height);
						},
					});
					frames[frameIndex] = url;
					onFrame?.({ index: frameIndex, url });
				} finally {
					frame.close();
				}
			}
		}

		return frames;
	} finally {
		input.dispose();
	}
}

export function getVideoFilmstrip({
	mediaId,
	file,
	startTime,
	endTime,
	frameCount,
	onFrame,
}: {
	mediaId: string;
	file: File;
	startTime: number;
	endTime: number;
	frameCount: number;
	onFrame?: ({ index, url }: { index: number; url: string }) => void;
}): Promise<string[]> {
	const key = buildCacheKey({ mediaId, startTime, endTime, frameCount });
	const cached = filmstripCache.get(key);
	if (cached) {
		// Refresh recency so hot entries survive eviction.
		filmstripCache.delete(key);
		filmstripCache.set(key, cached);
		return cached.promise;
	}

	const promise = generateVideoFilmstrip({
		file,
		startTime,
		endTime,
		frameCount,
		onFrame,
	}).catch((error) => {
		console.warn("Failed to generate video filmstrip", error);
		filmstripCache.delete(key);
		return [];
	});
	filmstripCache.set(key, { promise });
	if (filmstripCache.size > MAX_CACHE_ENTRIES) {
		const oldestKey = filmstripCache.keys().next().value;
		if (oldestKey) {
			filmstripCache.delete(oldestKey);
		}
	}
	return promise;
}

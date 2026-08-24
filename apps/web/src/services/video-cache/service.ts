import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";

interface VideoSinkData {
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
	latestRequestId: symbol | null;
	activeRequestId: symbol | null;
	prefetchRequestId: symbol | null;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("Video seek aborted", "AbortError");
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();

	async getFrameAt({
		mediaId,
		file,
		time,
		signal,
		prefetch = true,
		requestId,
	}: {
		mediaId: string;
		file: File;
		time: number;
		signal?: AbortSignal;
		prefetch?: boolean;
		requestId: symbol;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file });
		throwIfAborted(signal);

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		sinkData.latestRequestId = requestId;
		if (
			!prefetch &&
			((sinkData.activeRequestId && sinkData.activeRequestId !== requestId) ||
				(sinkData.prefetchRequestId &&
					sinkData.prefetchRequestId !== requestId))
		) {
			this.cancelPendingDecode({ sinkData });
		}

		const cancelPendingDecode = () => {
			if (sinkData.latestRequestId === requestId) {
				this.cancelPendingDecode({ sinkData });
			}
		};
		signal?.addEventListener("abort", cancelPendingDecode, { once: true });

		const previous = this.frameChain.get(mediaId) ?? Promise.resolve();
		const current = previous.then(async () => {
			if (sinkData.latestRequestId !== requestId) {
				return null;
			}
			throwIfAborted(signal);
			sinkData.activeRequestId = requestId;
			try {
				const frame = await this.resolveFrame({
					sinkData,
					time,
					signal,
					prefetch,
					requestId,
				});
				return sinkData.latestRequestId === requestId ? frame : null;
			} finally {
				if (sinkData.activeRequestId === requestId) {
					sinkData.activeRequestId = null;
				}
			}
		});
		this.frameChain.set(
			mediaId,
			current.catch(() => {}),
		);

		try {
			return await current;
		} finally {
			signal?.removeEventListener("abort", cancelPendingDecode);
		}
	}

	private async resolveFrame({
		sinkData,
		time,
		signal,
		prefetch,
		requestId,
	}: {
		sinkData: VideoSinkData;
		time: number;
		signal?: AbortSignal;
		prefetch: boolean;
		requestId: symbol;
	}): Promise<WrappedCanvas | null> {
		throwIfAborted(signal);
		if (sinkData.latestRequestId !== requestId) {
			return null;
		}
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			if (prefetch) this.startPrefetch({ sinkData, requestId });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (prefetch && !sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData, requestId });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({
				sinkData,
				targetTime: time,
				signal,
				requestId,
			});
			if (sinkData.latestRequestId !== requestId) {
				return null;
			}
			if (frame) {
				if (prefetch && !sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData, requestId });
				}
				return frame;
			}
		}

		return this.seekToTime({ sinkData, time, signal, requestId });
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
		signal,
		requestId,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
		signal?: AbortSignal;
		requestId: symbol;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				throwIfAborted(signal);
				if (sinkData.latestRequestId !== requestId) return null;
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
					throwIfAborted(signal);
					if (sinkData.latestRequestId !== requestId) return null;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const iterator = sinkData.iterator;
					if (!iterator) break;
					const { value: frame, done } = await iterator.next();
					throwIfAborted(signal);
					if (sinkData.latestRequestId !== requestId) return null;

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
		signal,
		requestId,
	}: {
		sinkData: VideoSinkData;
		time: number;
		signal?: AbortSignal;
		requestId: symbol;
	}): Promise<WrappedCanvas | null> {
		try {
			throwIfAborted(signal);
			if (sinkData.latestRequestId !== requestId) return null;
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
				throwIfAborted(signal);
				if (sinkData.latestRequestId !== requestId) return null;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				throwIfAborted(signal);
				if (sinkData.latestRequestId !== requestId) return null;
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;
			sinkData.prefetchRequestId = null;

			// Fetch current frame
			const iterator = sinkData.iterator;
			if (!iterator) return null;
			const { value: frame } = await iterator.next();
			throwIfAborted(signal);
			if (sinkData.latestRequestId !== requestId) return null;

			if (frame) {
				sinkData.currentFrame = frame;
				return frame;
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private cancelPendingDecode({ sinkData }: { sinkData: VideoSinkData }): void {
		sinkData.nextFrame = null;
		sinkData.activeRequestId = null;
		sinkData.prefetchRequestId = null;
		sinkData.prefetching = false;
		sinkData.prefetchPromise = null;
		const iterator = sinkData.iterator;
		sinkData.iterator = null;
		if (iterator) {
			void iterator.return().catch(() => {});
		}
	}

	private startPrefetch({
		sinkData,
		requestId,
	}: {
		sinkData: VideoSinkData;
		requestId: symbol;
	}): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		const iterator = sinkData.iterator;
		sinkData.prefetching = true;
		sinkData.prefetchRequestId = requestId;
		sinkData.prefetchPromise = this.prefetchNextFrame({
			sinkData,
			iterator,
			requestId,
		});
	}

	private async prefetchNextFrame({
		sinkData,
		iterator,
		requestId,
	}: {
		sinkData: VideoSinkData;
		iterator: AsyncGenerator<WrappedCanvas, void, unknown>;
		requestId: symbol;
	}): Promise<void> {
		try {
			const { value: frame, done } = await iterator.next();
			if (
				sinkData.iterator !== iterator ||
				sinkData.prefetchRequestId !== requestId
			) {
				return;
			}

			if (!done && frame) {
				sinkData.nextFrame = frame;
			}
		} catch (error) {
			if (
				sinkData.iterator === iterator &&
				sinkData.prefetchRequestId === requestId
			) {
				console.warn("Prefetch failed:", error);
				sinkData.iterator = null;
			}
		} finally {
			if (sinkData.prefetchRequestId === requestId) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				sinkData.prefetchRequestId = null;
			}
		}
	}
	private async ensureSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
			});

			this.sinks.set(mediaId, {
				input,
				sink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
				latestRequestId: null,
				activeRequestId: null,
				prefetchRequestId: null,
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
		this.frameChain.delete(mediaId);
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();

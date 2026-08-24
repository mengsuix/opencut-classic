"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useResizeObserver } from "@/hooks/use-resize-observer";
import { TIMELINE_AUDIO_WAVEFORM_COLOR } from "./theme";
import {
	buildWaveformSampleBuckets,
	sampleSourceWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import type { RetimeConfig } from "@/timeline";
import { getBarFractionFromOutputAmplitude } from "@/timeline/audio-display";
import { waveformCache } from "@/services/waveform-cache/service";
import {
	intersectViewportSpan,
	timelineViewport,
} from "@/timeline/viewport-store";
import { useRawTimelineViewport } from "@/timeline/hooks/use-timeline-viewport";
import { cn } from "@/utils/ui";

const BAR_WIDTH = 1;
const BAR_GAP = 1;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
const WAVEFORM_BURN_COLOR = "rgba(255, 110, 20, 0.9)";
export const WAVEFORM_GAIN_SAMPLE_COUNT = 200;

/** Painted beyond the viewport so small scrolls reveal already-drawn pixels. */
const WAVEFORM_OVERSCAN_PX = 256;

function sampleGainAtClipTime({
	samples,
	clipTimeSec,
	clipDurationSec,
}: {
	samples: number[];
	clipTimeSec: number;
	clipDurationSec: number;
}): number {
	if (samples.length === 0 || clipDurationSec <= 0) {
		return 1;
	}

	const progress = Math.max(0, Math.min(1, clipTimeSec / clipDurationSec));
	const rawIndex = progress * (samples.length - 1);
	const lo = Math.floor(rawIndex);
	const hi = Math.min(samples.length - 1, lo + 1);
	return samples[lo] + (samples[hi] - samples[lo]) * (rawIndex - lo);
}

interface AudioWaveformProps {
	sourceKey: string;
	sourceFile?: File;
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	gainSamples?: number[];
	pixelsPerSecond: number;
	clipDurationSec: number;
	retime?: RetimeConfig;
	sourceStartSec: number;
	/** Element's left edge in timeline content pixels. */
	elementLeftPx: number;
	/** Element's full width in timeline content pixels. */
	elementWidthPx: number;
	color?: string;
	burnColor?: string;
	className?: string;
}

export function AudioWaveform({
	sourceKey,
	sourceFile,
	audioUrl,
	audioBuffer,
	gainSamples,
	pixelsPerSecond,
	clipDurationSec,
	retime,
	sourceStartSec,
	elementLeftPx,
	elementWidthPx,
	color = TIMELINE_AUDIO_WAVEFORM_COLOR,
	burnColor = WAVEFORM_BURN_COLOR,
	className = "",
}: AudioWaveformProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const summaryRef = useRef<SourceWaveformSummary | null>(null);
	const waveformConfigRef = useCommittedRef({
		gainSamples,
		pixelsPerSecond,
		clipDurationSec,
		retime,
		sourceStartSec,
		elementLeftPx,
		elementWidthPx,
		color,
		burnColor,
	});
	const heightRef = useRef<number>(0);
	/**
	 * Cheap structural signature of the last painted frame. Comparing numbers
	 * avoids the per-frame `JSON.stringify` this used to do while scrolling.
	 */
	const lastRenderKeyRef = useRef<string | null>(null);

	const clearCanvas = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}

		const ctx = canvas.getContext("2d");
		if (ctx) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
		lastRenderKeyRef.current = null;
	}, []);

	const drawVisible = useCallback(() => {
		const canvas = canvasRef.current;
		const summary = summaryRef.current;
		const height = heightRef.current;

		if (!canvas || !summary || height <= 0) {
			clearCanvas();
			return;
		}

		const {
			gainSamples: gainSamplesValue,
			pixelsPerSecond: pixelsPerSecondValue,
			clipDurationSec: clipDurationSecValue,
			retime: retimeValue,
			sourceStartSec: sourceStartSecValue,
			elementLeftPx: elementLeftValue,
			elementWidthPx: elementWidthValue,
			color: colorValue,
			burnColor: burnColorValue,
		} = waveformConfigRef.current;

		if (elementWidthValue <= 0) {
			clearCanvas();
			return;
		}

		// Derive the visible slice from the shared viewport store rather than
		// measuring the DOM: `getBoundingClientRect` on a multi-million-pixel-wide
		// layout forces a synchronous reflow on every scroll frame.
		const visible = intersectViewportSpan({
			spanLeftPx: elementLeftValue,
			spanRightPx: elementLeftValue + elementWidthValue,
			viewport: timelineViewport.cached,
			overscanPx: WAVEFORM_OVERSCAN_PX,
		});
		if (!visible) {
			clearCanvas();
			return;
		}

		const clipLeft = visible.leftPx - elementLeftValue;
		const clipRight = visible.rightPx - elementLeftValue;
		const visibleWidth = clipRight - clipLeft;
		if (visibleWidth <= 0) {
			clearCanvas();
			return;
		}

		const dpr = window.devicePixelRatio || 1;
		const canvasW = Math.max(1, Math.ceil(visibleWidth * dpr));
		const canvasH = Math.max(1, Math.round(height * dpr));
		const barCount = Math.max(1, Math.floor(visibleWidth / BAR_STEP));
		const renderKey = [
			Math.round(clipLeft),
			Math.round(clipRight),
			canvasW,
			canvasH,
			barCount,
			pixelsPerSecondValue,
			clipDurationSecValue,
			sourceStartSecValue,
			retimeValue?.rate ?? 1,
			summary.sourceKey,
			summary.totalSamples,
			gainSamplesValue?.length ?? 0,
			colorValue,
			burnColorValue,
		].join("|");
		if (lastRenderKeyRef.current === renderKey) {
			return;
		}
		lastRenderKeyRef.current = renderKey;

		// Reallocating the backing store is expensive; only resize when needed.
		if (canvas.width !== canvasW || canvas.height !== canvasH) {
			canvas.width = canvasW;
			canvas.height = canvasH;
		}
		canvas.style.width = `${visibleWidth}px`;
		canvas.style.height = `${height}px`;
		canvas.style.left = `${clipLeft}px`;

		const backingScaleX = dpr;
		const backingScaleY = canvasH / height;

		const sampleBuckets = buildWaveformSampleBuckets({
			clipLeftPx: clipLeft,
			clipRightPx: clipRight,
			barCount,
			pixelsPerSecond: pixelsPerSecondValue,
			clipDurationSec: clipDurationSecValue,
			sourceStartSec: sourceStartSecValue,
			retime: retimeValue,
			sampleRate: summary.sampleRate,
			maxSampleExclusive: summary.totalSamples,
			barStepPx: BAR_STEP,
		});
		const amplitudes = sampleSourceWaveformSummary({
			summary,
			buckets: sampleBuckets,
		});

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvasW, canvasH);

		const clipBottom = canvasH;

		for (let i = 0; i < barCount; i++) {
			const barCenterPx = clipLeft + i * BAR_STEP + BAR_WIDTH * 0.5;
			const clipCenterSec = Math.max(
				0,
				Math.min(clipDurationSecValue, barCenterPx / pixelsPerSecondValue),
			);
			const gain =
				gainSamplesValue != null
					? sampleGainAtClipTime({
							samples: gainSamplesValue,
							clipTimeSec: clipCenterSec,
							clipDurationSec: clipDurationSecValue,
						})
					: 1;
			const amplitude = Math.max(0, amplitudes[i] ?? 0);
			const outputAmplitude = amplitude * Math.max(0, gain);
			const fraction = getBarFractionFromOutputAmplitude({ outputAmplitude });
			const barH = fraction > 0 ? Math.max(1, fraction * height) : 0;
			if (barH <= 0) {
				continue;
			}

			const barLeft = i * BAR_STEP;
			const barRight = barLeft + BAR_WIDTH;
			const deviceLeft = Math.round(barLeft * backingScaleX);
			const deviceRight = Math.max(
				deviceLeft + 1,
				Math.round(barRight * backingScaleX),
			);
			const deviceTop = Math.round((height - barH) * backingScaleY);
			const deviceHeight = Math.max(1, clipBottom - deviceTop);

			ctx.fillStyle = colorValue;
			ctx.fillRect(
				deviceLeft,
				deviceTop,
				deviceRight - deviceLeft,
				deviceHeight,
			);

			if (outputAmplitude > 1) {
				const burnHeight = Math.max(1, Math.round(BAR_WIDTH * backingScaleY));
				ctx.fillStyle = burnColorValue;
				ctx.fillRect(
					deviceLeft,
					deviceTop,
					deviceRight - deviceLeft,
					burnHeight,
				);
			}
		}
	}, [clearCanvas, waveformConfigRef]);

	useEffect(() => {
		let isCancelled = false;
		summaryRef.current = null;
		clearCanvas();

		void waveformCache
			.getSourceSummary({
				sourceKey,
				audioBuffer,
				sourceFile,
				audioUrl,
			})
			.then((summary) => {
				if (isCancelled) {
					return;
				}
				summaryRef.current = summary;
				drawVisible();
			})
			.catch(() => {
				// Waveform loading failed (e.g. corrupt file, unsupported format).
				// Fail silently — a missing waveform is preferable to an error state.
				if (!isCancelled) {
					clearCanvas();
				}
			});

		return () => {
			isCancelled = true;
		};
	}, [audioBuffer, audioUrl, clearCanvas, drawVisible, sourceFile, sourceKey]);

	useLayoutEffect(() => {
		drawVisible();
	}, [
		drawVisible,
		gainSamples,
		pixelsPerSecond,
		clipDurationSec,
		retime,
		sourceStartSec,
		elementLeftPx,
		elementWidthPx,
		color,
		burnColor,
	]);

	// One shared rAF-batched notification for every waveform on the timeline,
	// replacing a per-instance unthrottled scroll listener.
	useRawTimelineViewport(drawVisible);

	const onResize = useCallback(
		(entry: ResizeObserverEntry) => {
			heightRef.current = entry.contentRect.height;
			drawVisible();
		},
		[drawVisible],
	);

	useResizeObserver({ ref: containerRef, onResize });

	return (
		<div ref={containerRef} className={cn("relative size-full", className)}>
			<canvas ref={canvasRef} className="absolute bottom-0" />
		</div>
	);
}

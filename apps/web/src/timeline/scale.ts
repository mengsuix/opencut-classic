export const BASE_TIMELINE_PIXELS_PER_SECOND = 50;
export const TIMELINE_ZOOM_MIN = 0.1;
export const TIMELINE_ZOOM_MAX = 100;

/**
 * Hard ceiling on the timeline's DOM width in CSS pixels.
 *
 * Content rendering is windowed, but the scroll container's own width is real:
 * layout, scrollbar math and compositing all degrade as it grows, and browsers
 * cap a single axis around 33.5M px. Capping the width (and deriving max zoom
 * from it) keeps interaction cost independent of media duration, at the cost of
 * less magnification on very long timelines.
 */
export const MAX_TIMELINE_WIDTH_PX = 2_000_000;

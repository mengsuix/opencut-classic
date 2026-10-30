"use client";

import { Component, type ReactNode } from "react";

/** Catches render errors in children so a single broken panel does not take
 *  down the whole editor. Remount via a key change to reset the error state. */
export class ErrorBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode },
	{ hasError: boolean }
> {
	state = { hasError: false };

	static getDerivedStateFromError(): { hasError: boolean } {
		return { hasError: true };
	}

	componentDidCatch(error: unknown): void {
		console.error("ErrorBoundary caught a render error:", error);
	}

	render(): ReactNode {
		return this.state.hasError ? this.props.fallback : this.props.children;
	}
}

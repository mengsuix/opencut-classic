#!/bin/sh
# Start the web dev server with an up-to-date wasm build.
#
# apps/web depends on `opencut-wasm: file:../../rust/wasm/pkg`, but bun installs
# that as a *copy* in apps/web/node_modules/opencut-wasm, and the dev server
# loads the copy. `bun run build:wasm` only refreshes rust/wasm/pkg, so Rust
# changes silently never reached dev. This script rebuilds pkg when the Rust
# sources are newer, then syncs pkg into the installed copy.
set -e
cd "$(dirname "$0")"

PKG=rust/wasm/pkg
DEST=apps/web/node_modules/opencut-wasm

needs_build() {
	[ -f "$PKG/opencut_wasm_bg.wasm" ] || return 0
	[ -n "$(find rust/crates rust/wasm/src rust/wasm/Cargo.toml Cargo.lock \
		-newer "$PKG/opencut_wasm_bg.wasm" \( -name '*.rs' -o -name '*.toml' -o -name '*.wgsl' -o -name 'Cargo.lock' \) \
		-print 2>/dev/null | head -n 1)" ]
}

if needs_build; then
	if command -v wasm-pack >/dev/null 2>&1; then
		echo "[run_dev] Rust sources changed, rebuilding wasm..."
		bun run build:wasm
	else
		echo "[run_dev] WARNING: Rust sources are newer than $PKG but wasm-pack is not installed; using the existing build." >&2
	fi
fi

if [ -d "$PKG" ] && [ -d "$DEST" ]; then
	synced=0
	for f in "$PKG"/opencut_wasm*; do
		[ -f "$f" ] || continue
		name=$(basename "$f")
		if ! cmp -s "$f" "$DEST/$name"; then
			cp "$f" "$DEST/$name"
			synced=1
		fi
	done
	[ "$synced" = 1 ] && echo "[run_dev] Synced $PKG -> $DEST"
elif [ ! -d "$DEST" ]; then
	echo "[run_dev] $DEST not found, running bun install..."
	bun install
fi

exec bun dev:web

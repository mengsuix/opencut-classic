"""把 HyperFrames registry 的 components vendor 进 agent-gateway/registry/。

每个 component 只保留两样：registry-item.json（元数据：名称/描述/标签/变量）和
snippet 正文 HTML（files[0].path 指向的文件）。demo.html、预览图、字体等不进仓库。

用法：.venv/bin/python scripts/vendor_fx_registry.py <hyperframes源码路径>
例：  .venv/bin/python scripts/vendor_fx_registry.py ../extra/hyperframes
"""

import json
import shutil
import sys
from pathlib import Path

DEST = Path(__file__).resolve().parent.parent / "registry" / "components"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("用法: vendor_fx_registry.py <hyperframes源码路径>")
    src_root = Path(sys.argv[1]).resolve() / "registry" / "components"
    if not src_root.is_dir():
        sys.exit(f"源目录不存在: {src_root}")

    DEST.mkdir(parents=True, exist_ok=True)
    copied, skipped = 0, 0
    for item_dir in sorted(src_root.iterdir()):
        meta_path = item_dir / "registry-item.json"
        if not item_dir.is_dir() or not meta_path.is_file():
            skipped += 1
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        files = meta.get("files") or []
        if not files:
            skipped += 1
            continue
        snippet_rel = files[0]["path"]
        snippet_src = item_dir / snippet_rel
        if not snippet_src.is_file():
            skipped += 1
            continue
        dest_dir = DEST / item_dir.name
        dest_dir.mkdir(exist_ok=True)
        shutil.copy2(meta_path, dest_dir / "registry-item.json")
        shutil.copy2(snippet_src, dest_dir / Path(snippet_rel).name)
        copied += 1
    print(f"vendored {copied} components -> {DEST}（skipped {skipped}）")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Controlled discovery and download of sound material.

This script intentionally uses only the Python standard library. Search output is
written as a manifest; downloads must reference that manifest so provenance and
source-host checks remain coupled to the selected asset.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SCRIPT_ROOT = Path(__file__).resolve()
REPO_ROOT = SCRIPT_ROOT.parents[4]
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"}
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
USER_AGENT = "sound-material-acquisition/1.0"


class SoundMaterialError(RuntimeError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def json_print(value: Any, stream: Any = sys.stdout) -> None:
    json.dump(value, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^\w. -]+", "_", value, flags=re.UNICODE).strip(" .")
    return (cleaned or fallback)[:120]


def request_json(url: str, headers: dict[str, str] | None = None, timeout: int = 30) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def request_bytes(url: str, headers: dict[str, str] | None = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MAX_DOWNLOAD_BYTES:
            raise SoundMaterialError("remote file exceeds the 100 MiB safety limit")
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_DOWNLOAD_BYTES:
                raise SoundMaterialError("remote file exceeds the 100 MiB safety limit")
            chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise SoundMaterialError("remote response was empty")
    return data


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise SoundMaterialError(f"refusing to overwrite existing file: {path}")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", suffix=".part", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        if temporary:
            temporary.unlink(missing_ok=True)
        raise SoundMaterialError(f"failed to write {path}: {exc}") from exc


def write_metadata(audio_path: Path, result: dict[str, Any], query: str) -> Path:
    metadata_path = audio_path.with_suffix(audio_path.suffix + ".json")
    metadata = {
        "schema": 1,
        "retrieved_at": now_iso(),
        "query": query,
        "audio_path": str(audio_path),
        "provider": result.get("provider"),
        "title": result.get("title"),
        "author": result.get("author"),
        "duration_seconds": result.get("duration_seconds"),
        "license": result.get("license"),
        "source_url": result.get("source_url"),
        "source_id": result.get("source_id"),
        "sha256": hashlib.sha256(audio_path.read_bytes()).hexdigest(),
    }
    try:
        if metadata_path.exists():
            raise SoundMaterialError(f"refusing to overwrite existing metadata: {metadata_path}")
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise SoundMaterialError(f"failed to write metadata {metadata_path}: {exc}") from exc
    return metadata_path


def local_dirs(explicit: list[str] | None) -> list[Path]:
    if explicit:
        return [Path(value).expanduser() for value in explicit]
    configured = os.environ.get("MUSIC_LIBRARY_DIR")
    candidates = [Path(configured).expanduser()] if configured else []
    candidates.extend([REPO_ROOT / "music_library", REPO_ROOT / "assets" / "audio"])
    return list(dict.fromkeys(candidates))


def local_search(args: argparse.Namespace) -> list[dict[str, Any]]:
    tokens = [token.lower() for token in re.findall(r"\w+", args.query)]
    results: list[dict[str, Any]] = []
    for directory in local_dirs(args.library_dir):
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*"), key=lambda item: item.as_posix().lower()):
            if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            haystack = path.name.lower()
            if tokens and not all(token in haystack for token in tokens):
                continue
            results.append({
                "provider": "local",
                "source_id": str(path),
                "title": path.stem,
                "author": None,
                "duration_seconds": None,
                "license": "unknown; preserve the file's existing license information",
                "source_url": None,
                "download_url": None,
                "local_path": str(path),
            })
            if len(results) >= args.limit:
                return results
    return results


def freesound_search(args: argparse.Namespace) -> list[dict[str, Any]]:
    token = os.environ.get("FREESOUND_API_KEY")
    if not token:
        raise SoundMaterialError("FREESOUND_API_KEY is not set")
    filters: list[str] = []
    if args.min_duration is not None:
        filters.append(f"duration:[{args.min_duration} TO {args.max_duration or 600}]")
    params = {
        "query": args.query,
        "sort": "rating_desc",
        "fields": "id,name,duration,previews,tags,avg_rating,username,license,url",
        "token": token,
        "page_size": str(args.limit),
    }
    if filters:
        params["filter"] = " ".join(filters)
    url = "https://freesound.org/apiv2/search/text/?" + urllib.parse.urlencode(params)
    data = request_json(url, timeout=30)
    results: list[dict[str, Any]] = []
    for item in data.get("results", []):
        previews = item.get("previews") or {}
        download_url = previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3")
        if not download_url:
            continue
        results.append({
            "provider": "freesound",
            "source_id": str(item.get("id")),
            "title": item.get("name") or "Untitled Freesound asset",
            "author": item.get("username"),
            "duration_seconds": item.get("duration"),
            "license": item.get("license") or "check the individual Freesound license",
            "source_url": item.get("url") or f"https://freesound.org/s/{item.get('id')}/",
            "download_url": download_url,
            "rating": item.get("avg_rating"),
            "tags": item.get("tags") or [],
        })
    return results


def pixabay_search(args: argparse.Namespace) -> list[dict[str, Any]]:
    slug = urllib.parse.quote(re.sub(r"\s+", "-", args.query.strip().lower()), safe="-")
    search_url = f"https://pixabay.com/music/search/{slug}/"
    request = urllib.request.Request(search_url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; sound-material-acquisition/1.0)",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        html = response.read().decode("utf-8", errors="replace")
    match = re.search(r"window\.__BOOTSTRAP_URL__\s*=\s*[\"']([^\"']+)[\"']", html)
    if not match:
        raise SoundMaterialError("Pixabay bootstrap data was not found; the site layout may have changed")
    bootstrap_url = urllib.parse.urljoin("https://pixabay.com", match.group(1))
    data = request_json(bootstrap_url, headers={"Referer": search_url}, timeout=20)
    results: list[dict[str, Any]] = []
    for item in data.get("page", {}).get("results", []):
        sources = item.get("sources") or {}
        download_url = sources.get("src")
        if not download_url:
            continue
        user = item.get("user") or {}
        duration = item.get("duration")
        if args.min_duration is not None and duration is not None:
            if duration < args.min_duration or duration > (args.max_duration or 600):
                continue
        results.append({
            "provider": "pixabay",
            "source_id": str(item.get("id") or ""),
            "title": item.get("name") or sources.get("filename") or "Untitled Pixabay track",
            "author": user.get("username"),
            "duration_seconds": duration,
            "license": "Pixabay Content License; verify current terms for the intended use",
            "source_url": search_url,
            "download_url": download_url,
            "rating": item.get("rating"),
        })
        if len(results) >= args.limit:
            break
    return results


def search(args: argparse.Namespace) -> int:
    providers = [item.strip().lower() for item in args.providers.split(",") if item.strip()]
    handlers = {"local": local_search, "freesound": freesound_search, "pixabay": pixabay_search}
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for provider in providers:
        handler = handlers.get(provider)
        if not handler:
            errors.append({"provider": provider, "error": "unsupported provider"})
            continue
        try:
            results.extend(handler(args))
        except Exception as exc:
            errors.append({"provider": provider, "error": str(exc)})
    manifest = {
        "schema": 1,
        "created_at": now_iso(),
        "kind": args.kind,
        "query": args.query,
        "providers": providers,
        "results": results[: args.limit],
        "errors": errors,
    }
    if args.json_out:
        output = Path(args.json_out).expanduser()
        try:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            raise SoundMaterialError(f"failed to write search manifest {output}: {exc}") from exc
    json_print(manifest)
    return 0 if results else 1


def allowed_host(provider: str, url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower().rstrip(".")
    if provider == "freesound":
        return host == "freesound.org" or host.endswith(".freesound.org")
    if provider == "pixabay":
        return host == "pixabay.com" or host.endswith(".pixabay.com")
    return False


def download(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).expanduser()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SoundMaterialError(f"failed to read manifest {manifest_path}: {exc}") from exc
    if manifest.get("schema") != 1 or not isinstance(manifest.get("results"), list):
        raise SoundMaterialError("unsupported or malformed search manifest")
    results = manifest["results"]
    if args.index < 0 or args.index >= len(results):
        raise SoundMaterialError(f"result index {args.index} is out of range (0-{max(len(results) - 1, 0)})")
    result = results[args.index]
    provider = result.get("provider")
    output_dir = Path(args.output_dir).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    title = safe_name(str(result.get("title") or "sound-material"), "sound-material")
    extension = Path(urllib.parse.urlparse(result.get("download_url") or "").path).suffix.lower()
    if extension not in AUDIO_EXTENSIONS:
        extension = Path(result.get("local_path") or "").suffix.lower()
    if extension not in AUDIO_EXTENSIONS:
        extension = ".mp3"
    filename = args.filename or f"{provider}_{title}{extension}"
    if Path(filename).name != filename:
        raise SoundMaterialError("--filename must be a simple filename without directory components")
    output_path = output_dir / filename
    if provider == "local":
        source = Path(result.get("local_path", "")).expanduser()
        if not source.is_file():
            raise SoundMaterialError(f"local source file does not exist: {source}")
        if output_path.exists():
            raise SoundMaterialError(f"refusing to overwrite existing file: {output_path}")
        temporary = output_path.with_name(f".{output_path.name}.part")
        try:
            shutil.copy2(source, temporary)
            os.replace(temporary, output_path)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise SoundMaterialError(f"failed to copy local audio {source} to {output_path}: {exc}") from exc
    else:
        url = result.get("download_url")
        if not isinstance(url, str) or not allowed_host(str(provider), url):
            raise SoundMaterialError(f"download URL is not allowed for provider {provider}")
        write_atomic(output_path, request_bytes(url, headers={"Referer": result.get("source_url") or ""}))
    metadata_path = write_metadata(output_path, result, str(manifest.get("query") or ""))
    json_print({"ok": True, "audio_path": str(output_path), "metadata_path": str(metadata_path), "result": result})
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Search and download sound material with provenance metadata.")
    sub = root.add_subparsers(dest="command", required=True)
    search_parser = sub.add_parser("search", help="search one or more sound material providers")
    search_parser.add_argument("--kind", choices=("sfx", "music"), required=True)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--providers", default=None, help="comma-separated: local,freesound,pixabay")
    search_parser.add_argument("--library-dir", action="append")
    search_parser.add_argument("--min-duration", type=float, default=None)
    search_parser.add_argument("--max-duration", type=float, default=None)
    search_parser.add_argument("--limit", type=int, default=10)
    search_parser.add_argument("--json-out")
    search_parser.set_defaults(func=search)
    download_parser = sub.add_parser("download", help="download one selected manifest result")
    download_parser.add_argument("--manifest", required=True)
    download_parser.add_argument("--index", type=int, required=True)
    download_parser.add_argument("--output-dir", required=True)
    download_parser.add_argument("--filename")
    download_parser.set_defaults(func=download)
    return root


def main() -> int:
    args = parser().parse_args()
    if args.command == "search":
        if args.providers is None:
            args.providers = "local,freesound" if args.kind == "sfx" else "local,freesound,pixabay"
        if args.limit < 1 or args.limit > 50:
            parser().error("--limit must be between 1 and 50")
        if args.min_duration is not None and args.min_duration < 0:
            parser().error("--min-duration cannot be negative")
        if args.max_duration is not None and args.max_duration <= 0:
            parser().error("--max-duration must be positive")
    try:
        return args.func(args)
    except Exception as exc:
        json_print({"ok": False, "error": str(exc)}, sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

---
name: sound-material-acquisition
description: Search, evaluate, and download sound effects or background music from the local library, Freesound, and Pixabay. Use when an agent needs external or local audio assets for a video, edit, timeline, or sound design task.
license: MIT
compatibility: Requires Python 3.9+ for the bundled script. Freesound requires FREESOUND_API_KEY; Pixabay is experimental and needs network access.
---

# Sound Material Acquisition

Use this skill when the agent needs to find or obtain reusable audio material. It covers short sound effects, ambience, loops, and background music. It does not modify the editor or project runtime; it only produces audio files and acquisition metadata.

## Source policy

Choose sources in this order unless the user specifies otherwise:

1. **Local library** — preferred for stable, offline, already-approved material. Scan `MUSIC_LIBRARY_DIR`, `<repo>/music_library`, and `<repo>/assets/audio` when present.
2. **Freesound** — preferred online source for sound effects, ambience, loops, and Creative Commons candidates. Requires `FREESOUND_API_KEY`.
3. **Pixabay Music** — optional source for produced background music. It is scraped from the public website and is experimental; do not rely on it as the only source.
4. **AI generation** — use an existing music or sound-effect generation skill/provider only when search results are unsuitable or the user explicitly asks for generated audio. Do not claim generated audio is royalty-free without checking that provider's terms.

Never silently replace a failed provider with an unverified URL. Report provider failures and continue searching other configured providers.

## Workflow

### 1. Clarify the target

Before searching, determine as much as possible from the request:

- `kind`: `sfx` for a short effect/ambience, or `music` for background music.
- Query and context: describe the sound, mood, instrumentation, scene, and intended use.
- Approximate duration and whether looping is needed.
- Commercial use and attribution requirements.
- Output location. Prefer the project's audio asset directory or the path explicitly requested by the user.

If the user has not specified duration, use 0.5–30 seconds for SFX and 15–180 seconds for music. These are search ranges, not editing requirements.

### 2. Search and inspect candidates

Run the bundled tool from the repository root:

```bash
python3 .claude/skills/sound-material-acquisition/scripts/sound_material.py search --kind sfx --query "soft notification chime" --json-out artifacts/sound-search.json
```

For background music:

```bash
python3 .claude/skills/sound-material-acquisition/scripts/sound_material.py search --kind music --query "warm minimal technology background" --json-out artifacts/sound-search.json
```

The default provider order is local + Freesound for SFX, and local + Freesound + Pixabay for music. Use `--providers local,freesound` or another explicit list when the user has a source constraint.

Inspect the JSON result before downloading. Prefer candidates with:

- appropriate duration and sonic character;
- a clear title, author, source page, and license;
- an actual downloadable audio URL;
- no unexplained attribution or commercial-use restriction.

The tool returns provider errors in `errors` while preserving successful results. A missing API key is a provider-unavailable condition, not a reason to fabricate a result.

### 3. Download only the selected candidate

After selecting a result by its zero-based index:

```bash
python3 .claude/skills/sound-material-acquisition/scripts/sound_material.py download --manifest artifacts/sound-search.json --index 0 --output-dir assets/audio
```

The command:

- restricts remote downloads to the source hosts returned by the tool;
- downloads to a temporary file and atomically renames it after a successful transfer;
- rejects empty or oversized downloads;
- writes a sidecar JSON file beside the audio containing provider, source URL, author, license, query, and retrieval time;
- fails explicitly if copying or writing the selected file fails.

Do not use a raw `curl`/`wget` URL when a manifest can be used. This keeps the source and licensing metadata coupled to the downloaded file.

### 4. Report provenance

When presenting the result, include the local output path and the sidecar metadata path. For Freesound, tell the user to review the individual sound's license and attribution requirements. For Pixabay, state that the current Pixabay Content License must still be checked for the intended use. For local files, preserve any existing license information and do not infer ownership.

## Provider-specific rules

### Local

Local discovery is read-only and searches common audio extensions (`mp3`, `wav`, `m4a`, `aac`, `flac`, `ogg`, `opus`, `aiff`). Set `MUSIC_LIBRARY_DIR` or pass `--library-dir` when the library is elsewhere. A local file is not automatically licensed for redistribution.

### Freesound

Set `FREESOUND_API_KEY` in the environment; never put the key in a prompt, manifest, or committed file. The tool downloads the best available MP3 preview, not necessarily the original source file. The source page and license are retained in metadata. Treat 401, 403, 429, timeout, and empty-result responses as explicit provider errors.

### Pixabay

Pixabay search is experimental because it reads the site's bootstrap data rather than a stable public API. Use it primarily for background music. If parsing or downloading fails, report that and fall back to local/Freesound or an approved generation provider.

### Generated audio

This Skill does not implement provider-specific AI generation APIs. If generation is needed, use the relevant existing provider Skill, save the generated file into the same output directory, and create equivalent provenance metadata including provider, model, prompt, generation time, and applicable usage terms.

## Guardrails

- Do not download until the user or task has selected a candidate, unless the user explicitly asks for automatic best-match acquisition.
- Do not describe a file as royalty-free solely because it came from Freesound or Pixabay.
- Do not overwrite an existing file accidentally; choose a new name or confirm replacement through the task context.
- Do not commit API keys, raw search manifests containing secrets, or unreviewed third-party audio.
- If no usable source is available, report the exact provider errors and offer local import or approved generation as the next option.

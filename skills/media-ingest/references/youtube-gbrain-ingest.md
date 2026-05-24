# YouTube → gbrain ingest notes

Session-derived workflow for ingesting a YouTube video into Panda's Brain when the normal transcript helper is incomplete.

## Fallback transcript capture

1. Try the `youtube-content` helper first.
2. If it returns `No transcript found`, probe captions with:

```bash
yt-dlp --skip-download --print '%(title)s\n%(channel)s\n%(duration_string)s\n%(webpage_url)s\n%(automatic_captions_table)s\n%(subtitles_table)s' '<url>'
```

3. If a subtitle track exists, download VTT:

```bash
tmp=$(mktemp -d)
yt-dlp --skip-download --write-subs --sub-langs zh-TW --sub-format vtt -o "$tmp/%(id)s.%(ext)s" '<url>'
```

4. Parse the VTT locally into timestamped paragraphs before writing the Brain page.

## gbrain write path

Use `gbrain put <slug> < page.md>` for the page. Use a class-level media slug, e.g.:

```text
media/youtube/<speaker-or-channel>-<topic>-YYYY-MM-DD
```

Recommended sections:

- Summary
- Key Segments / Highlights
- People Mentioned
- Companies / Labs Mentioned
- Panda Relevance
- Original Transcript
- Timeline

## Entity propagation

After `gbrain put`, verify links with:

```bash
gbrain graph <slug> --depth 1
```

If a mentioned person does not exist, create a lightweight `people/<slug>` page and link both directions:

```bash
gbrain put people/<person-slug> < person.md
gbrain link <media-slug> people/<person-slug> --type mentions
gbrain link people/<person-slug> <media-slug> --type mentioned_in
```

Add timeline entries to existing company/person pages when relevant.

## Pitfalls

- `gbrain files upload-raw <file> --page <slug>` may print `success:true` while `gbrain files list <slug>` shows no files, depending on storage backend or CLI behavior. Always verify file attachment listing before claiming raw files are attached. If listing fails, report page write success separately from attachment uncertainty.
- `gbrain embed <slug>` can fail with `OpenAI embedding requires OPENAI_API_KEY`. If so, page creation still succeeded, but `gbrain search/query` may not immediately find it. Verify with `gbrain list --type source` or `gbrain get <slug>` instead.
- Avoid piping `gbrain` output directly into an interpreter in approval-sensitive environments; capture output to a file or inspect directly instead.

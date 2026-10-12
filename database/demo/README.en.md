# Synthetic Demo Data

[中文](README.md) | [English](README.en.md)

This directory holds a minimal set of **author-written synthetic** rows so a blank database can render a populated homepage, topic pages and imagery card for screenshots, demos and manual UI checks. It is **not** collected real data.

## Contents

- `imagery/<sha256>`: a geometric placeholder drawn by this project (concentric rings rendered from an SVG) — not a real astronomical photograph and not a NASA APOD image. The filename is the SHA256 of its own bytes, matching the media key the imagery route expects.
- The rows themselves are written by [`scripts/demo-showcase.ts`](../../scripts/demo-showcase.ts): one disabled demo source, five news items marked "【演示数据】" across different categories and topic tags, and one imagery archive record whose English and Chinese descriptions are both author-written with `translation_status` and `media_status` set to `ready`, mirroring the normal "media and translation both landed" state.

## Usage

```sh
# after migrating and seeding sources
node --env-file=.env scripts/demo-showcase.ts
# the homepage imagery card additionally needs IMAGERY_ENABLED=true, then restart api/web

# remove exactly the rows this directory wrote; nothing else is touched
node --env-file=.env scripts/demo-showcase.ts --clean
```

Both directions are re-runnable. The script calls no model, fetches no upstream source and writes no receipts.

## Boundaries

- Every title, summary and description carries a demo marker and references no real institution, mission, paper, report or image.
- The imagery card shows the author-made placeholder; `sourceUrl` points at the reserved domain `example.invalid`, not a real source.
- The imagery row keeps the archive table's `source` value `nasa-apod`: the table constraint and the write validator accept no other value, so changing it would break the application's own invariant. The archive page therefore shows the label `NASA APOD`, while the row's title ("not an APOD image"), description, credit and the picture itself all state that it is an author-made synthetic demo. `mediaType` is `image`, so the "original video" note does not appear. Do not treat it as a real image or translation.
- Do not publish these rows as real content; fill a real deployment through your own collection and review pipeline.

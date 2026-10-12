# Nobel Prize Topic Page

[中文](NOBEL.md) | [English](NOBEL.en.md)

`/nobel` is a topic page of this site. It is a resource route that returns a self-contained HTML document with its own styling, keeping the document's search, filters, detail dialog and theme toggle. Entries are offered in the desktop sidebar, on the phone "More" page, and at the top of the homepage main column.

## What this release ships

This package ships **no** third-party award text, imagery, logo or reposted article. `apps/web/app/features/nobel/demo.html` and `nobel-demo-banner.png` are **synthetic demo** assets written by this project; the page states "合成演示 · 非真实获奖信息" on its face and contains no real award, laureate, citation or official link, and does not fabricate real winners.

## Supplying your own content

`apps/web/app/routes/nobel.ts` does two things: it replaces `{{NOBEL_PENDING_SUMMARY}}` with a count derived from the announcement calendar, and it rewrites the document's image placeholder to the bundled asset URL. To plug in your own content:

1. Replace `features/nobel/demo.html` with a document you are entitled to publish and whose provenance and licence you have recorded.
2. Keep the `.calrow` rows and the `待揭晓` markers; `pendingSummary()` and its test derive the count from them. Update `apps/web/tests/nobel.test.ts` if the calendar row structure changes.
3. Replace or drop the illustration. Third-party images, institutional logos and trademarks are not covered by the code's MIT licence.

## Semantics

The count reports **announcement status** (published or not), not official fact verification. It does not extrapolate from time and does not call any external award site. Content is maintained by hand; automatic updates are not promised.

## Licence

The page code follows the repository's MIT licence. Any third-party award text, imagery or institutional logo referenced by the page must be licensed by the deployer; public accessibility does not imply freedom to redistribute.

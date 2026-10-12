[中文](SOURCES.md) | [English](SOURCES.en.md)

# Built-in Information Sources and Alternative Integrations

> This catalog is based on `industry/sources.json` in the reference version. A built-in configuration does not mean automatic enablement, confirmed content rights, or long-term availability; the corresponding file must be checked for the final release. Collection is disabled by default in the public edition. Users should first select sources, check their intended uses and budgets, and then enable collection themselves.

## 1. Institutional News Sources with Supplied Configurations

The project already provides web-list or RSS configurations for these sources. The addresses below are source entry points, not statements granting permission to republish full text or images.

| Source | Stable ID | Integration method | Entry point |
|---|---|---|---|
| National Astronomical Observatories · Research News | `web-bao-research` | `web_list` | https://www.bao.ac.cn/news/ky/ |
| Purple Mountain Observatory · Research Progress | `web-pmo-research` | `web_list` | https://pmo.cas.cn/xwdt2019/kyjz2019/ |
| Shanghai Astronomical Observatory · Research Progress | `web-shao-research` | `web_list` | https://shao.cas.cn/2020Ver/xwdt/kyjz/ |
| ESO · Science News | `rss-eso-news` | `rss` | https://www.eso.org/public/news/feed/ |
| ESA Space Science | `rss-esa-science` | `rss` | https://www.esa.int/rssfeed/ESC |
| ESA Hubble · News | `rss-esa-hubble` | `rss` | https://esahubble.org/news/feed/ |
| ESA Webb · News | `rss-esa-webb` | `rss` | https://esawebb.org/news/feed/ |
| NOIRLab · News | `rss-noirlab` | `rss` | https://noirlab.edu/public/news/feed/ |

## 2. Candidate Magazine / Publication Sources

All sources below already have RSS configurations. The reference configuration defaults to `enabled:false`, T2, and 1440 minutes, with public full-text display / redistribution and magazine-image display disabled. General-interest publications still require astronomy-relevance filtering; do not force non-astronomy items into the system merely to fill a page.

Earlier configuration notes listed APS Physics and Nature Astronomy as “not integrated in the first release”; they have since been included among optional integrations. This document does not treat that old note as a permanent prohibition. Users must still choose which sources to enable in the final public configuration according to their intended uses. A private site's trial-run status must not be presented as the release's default enabled state.

| Source | Stable ID | RSS entry point |
|---|---|---|
| Science · Space | `rss-journal-science-space` | https://www.science.org/action/showFeed?ui=0&mi=sfug99&type=search&feed=rss&query=%2526ConceptID%253D502894%2526target%253Dtopic |
| Sky & Telescope · Astronomy News | `rss-journal-sky-telescope` | https://skyandtelescope.org/astronomy-news/feed/ |
| Astronomy Magazine · News | `rss-journal-astronomy-magazine` | https://www.astronomy.com/tags/news/feed/ |
| Nature · General | `rss-journal-nature` | https://www.nature.com/nature.rss |
| Scientific American | `rss-journal-scientific-american` | https://www.scientificamerican.com/platform/syndication/rss/ |
| Quanta Magazine · Astronomy | `rss-journal-quanta-astronomy` | https://www.quantamagazine.org/tag/astronomy/feed/ |
| New Scientist · Space | `rss-journal-new-scientist-space` | https://www.newscientist.com/subject/space/feed/ |
| Astronomy Magazine · The Sky This Week | `rss-journal-astronomy-sky-this-week` | https://www.astronomy.com/tags/sky-this-week/feed/ |
| APS Physics | `rss-journal-aps-physics` | https://feeds.aps.org/rss/recent/physics.xml |
| Nature Astronomy | `rss-journal-nature-astronomy` | https://www.nature.com/natastron.rss |

Astronomy News and Sky This Week may contain the same article. Deduplicate by canonical URL / material identity rather than counting the two feeds as two new articles. Feed-item counts from general-content sources such as Nature, Scientific American, and APS are not counts of valid astronomy items.

## 3. Modules Separate from Ordinary News Sources

- **arXiv astro-ph papers**: These have separate metadata, versioning, preliminary screening, and reporting paths. Do not conflate paper candidates with ordinary news scoring. Follow the dedicated configuration and date policy in the final release; whether they are included in the first release must be rechecked.
- **APOD images**: The reference source code includes optional bilingual image content and date archives. Check source permissions, third-party attribution, and image-feature switches separately. Presence in the source code does not mean default enablement in the first release.
- **Existing external-import capability**: This can integrate independent producers that conform to the actual interface contract. The public package does not include the private site's operational sources, connection addresses, or authentication.

## 4. Alternative Sources Without Ready-made Configurations

The project does not provide an additional list described as “fully verified.” Developers may integrate other official institutions, journals, or media themselves: prefer their official RSS / Atom feeds; if no feed exists, evaluate the supported web-list or JSON-list methods. Do not write a separate crawler for every organization, and do not infer that an adapter exists from a source's name.

Before adding a source, check its terms and content scope. Use the admin preview to inspect titles / URLs / dates; do not force unsupported fields into the configuration. Enable scheduling only after verifying a small-batch real workflow, deduplication, public pages, and budget. For 403/429 responses, empty feeds, or parsing failures, retain per-source diagnostics. Do not display empty placeholder cards or use old content to manufacture a “successful addition.”

## 5. Checks Before Use

1. Whether the entry point is still an official address and whether the feed covers the target section and historical window.
2. Whether the original publication date, time zone, and date precision are correct; never substitute the fetch time for the original publication date.
3. Whether publicly available RSS material is sufficient to support a reading guide; do not bypass paywalls or login walls.
4. Whether there is a separate basis for each use: full text, images, AI input, and redistribution.
5. Whether collection frequency, initial-fetch item count, and model budget suit your deployment.

See [Operating Cadence](CADENCE.en.md), [Admin Settings](ADMIN.en.md), and [Content-rights Verification Method](CONTENT-RIGHTS.en.md).

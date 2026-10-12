import document from "../features/nobel/demo.html?raw";
import demoBanner from "../features/nobel/nobel-demo-banner.png?url";

// The topic is served as a resource route so the reviewed document keeps its own markup,
// styles and native interactions instead of being re-implemented as a React tree.
//
// The document shipped here is written by this project (`features/nobel/demo.html`). It
// carries synthetic demo data only — no award facts, no laureates, no third-party text or
// imagery — and says so on the page. The asset below is likewise drawn by this project.

// Count publication states, not official fact verification, from the review calendar.
export function pendingSummary(html: string) {
  const rows = [...html.matchAll(/<div class="calrow(?: [^"]*)?">([\s\S]*?)<\/div>/g)];
  const pending = rows.filter((row) => />待揭晓<\/span>/.test(row[1])).length;
  return html.replace("{{NOBEL_PENDING_SUMMARY}}", `${pending} 项待揭晓`);
}

export function loader() {
  return new Response(pendingSummary(document).replaceAll("merged-assets/nobel-demo-banner.png", demoBanner), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

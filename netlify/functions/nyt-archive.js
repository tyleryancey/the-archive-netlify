/*
 * nyt-archive — Netlify function that proxies the NYT Archive API.
 *
 * IMPORTANT: Netlify caps a synchronous function's response at ~6 MB, and an
 * Archive *month* is far larger than that (it includes every article, print and
 * web, with full metadata). So this function does the heavy lifting server-side:
 * it fetches the month, keeps only PRINT articles, and returns just the fields
 * the app uses. That shrinks ~30 MB down to ~1-2 MB — under the cap — while
 * keeping the SAME response shape ({ response: { docs: [...] } }), so the app
 * needs no changes.
 *
 * Served from your site's own origin via the /svc/archive/* rewrite, so the
 * browser applies no CORS. Your NYT key travels only between your device and
 * your own site. Needs Node 18+ (global fetch); see NODE_VERSION in netlify.toml.
 */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Vary": "Origin",
  };
}

function jsonResp(statusCode, obj) {
  const headers = corsHeaders();
  headers["Content-Type"] = "application/json; charset=utf-8";
  return { statusCode, headers, body: JSON.stringify(obj) };
}

// Keep only the fields the app reads, so the response stays small.
function slimDoc(d) {
  const h = d.headline || {};
  return {
    web_url: d.web_url || "",
    headline: { main: h.main || "", print_headline: h.print_headline || "" },
    print_page: d.print_page,
    print_section: d.print_section || "",
    section_name: d.section_name || "",
    news_desk: d.news_desk || "",
    byline: { original: (d.byline && d.byline.original) || "" },
    abstract: d.abstract || d.snippet || d.lead_paragraph || "",
    pub_date: d.pub_date || "",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "GET") return jsonResp(405, { error: "Method not allowed" });

  // Recover the requested path + query (handle original or rewritten form).
  let pathname = "";
  let search = "";
  try {
    const u = new URL(event.rawUrl);
    pathname = u.pathname;
    search = u.search;
  } catch (e) {
    pathname = event.path || "";
    search = event.rawQuery ? "?" + event.rawQuery : "";
  }
  let archive = null;
  const i = pathname.indexOf("/svc/archive/");
  if (i !== -1) {
    archive = pathname.slice(i);
  } else {
    const m = pathname.indexOf("/nyt-archive/");
    if (m !== -1) archive = "/svc/archive/" + pathname.slice(m + "/nyt-archive/".length);
  }
  if (!archive) return jsonResp(404, { error: "Only /svc/archive/ is proxied." });

  const target = "https://api.nytimes.com" + archive + search;

  let upstream;
  try {
    upstream = await fetch(target, { headers: { Accept: "application/json" } });
  } catch (e) {
    return jsonResp(502, { error: "Upstream fetch failed: " + (e && e.message ? e.message : "unknown") });
  }

  // Pass small error bodies (401/429/etc.) straight through so the app reacts.
  if (!upstream.ok) {
    const text = await upstream.text();
    const headers = corsHeaders();
    headers["Content-Type"] = upstream.headers.get("content-type") || "application/json";
    return { statusCode: upstream.status, headers, body: text.slice(0, 4096) };
  }

  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    return jsonResp(502, { error: "Could not parse the NYT response." });
  }

  const docs = (data && data.response && data.response.docs) || [];
  const slim = [];
  for (let k = 0; k < docs.length; k++) {
    const d = docs[k];
    if (!String(d.print_page || "").trim()) continue; // print edition only
    slim.push(slimDoc(d));
  }

  return jsonResp(200, { response: { docs: slim } });
};

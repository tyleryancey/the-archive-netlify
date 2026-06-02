/*
 * nyt-archive — Netlify function that proxies the NYT Archive API.
 *
 * Because it's served from your site's own origin (via the /svc/archive/*
 * rewrite in netlify.toml), the browser treats the call as same-origin and
 * applies no CORS at all. CORS headers are still included so this also works
 * if you ever point a differently-hosted app at it.
 *
 * Needs the Node 18+ runtime (for global fetch), which is Netlify's default.
 * Your NYT key travels only between your device and your own site.
 */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Vary": "Origin",
  };
}

function resp(statusCode, body, headers) {
  return { statusCode, headers: headers || corsHeaders(), body };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return resp(204, "", corsHeaders());
  if (event.httpMethod !== "GET") return resp(405, "Method not allowed");

  // Recover the requested path + query. event.rawUrl is the original request URL.
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

  // Resolve the archive path whether we see the original URL or the function path.
  let archive = null;
  const i = pathname.indexOf("/svc/archive/");
  if (i !== -1) {
    archive = pathname.slice(i);
  } else {
    const m = pathname.indexOf("/nyt-archive/");
    if (m !== -1) archive = "/svc/archive/" + pathname.slice(m + "/nyt-archive/".length);
  }
  if (!archive) return resp(404, "Only /svc/archive/ is proxied.");

  const target = "https://api.nytimes.com" + archive + search;
  try {
    const upstream = await fetch(target, { headers: { Accept: "application/json" } });
    const body = await upstream.text();
    const headers = corsHeaders();
    headers["Content-Type"] = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    return { statusCode: upstream.status, headers, body };
  } catch (e) {
    const headers = corsHeaders();
    headers["Content-Type"] = "application/json; charset=utf-8";
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Upstream fetch failed" }) };
  }
};

// Proxies /api/* from the Vercel frontend to the MeritGrant backend.
//
// The browser only ever talks to this same-origin route, so there is no CORS
// setup and the backend URL is never exposed to the client. The backend lives
// behind a Cloudflare tunnel whose hostname changes, so it is read from the
// BACKEND_URL environment variable rather than hardcoded.
export default async function handler(req, res) {
  const base = process.env.BACKEND_URL;
  if (!base) {
    return res.status(500).json({ error: "BACKEND_URL is not set on this deployment" });
  }

  const parts = req.query.path;
  const path = Array.isArray(parts) ? parts.join("/") : String(parts || "");
  const target = `${base.replace(/\/+$/, "")}/api/${path}`;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(text);
  } catch (e) {
    // Usually means the tunnel URL rotated or the backend is down.
    res.status(502).json({ error: "Backend unreachable", detail: String(e), target });
  }
}

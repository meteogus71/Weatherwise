const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const FEED_URL = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece';
const CACHE_MS = 5 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

let cachedFeed = null;
let cachedAt = 0;
let lastGoodFeed = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
}

async function getMeteoAlarmFeed() {
  const now = Date.now();
  if (cachedFeed && now - cachedAt < CACHE_MS) {
    return { body: cachedFeed, cache: 'HIT', stale: false };
  }

  const upstream = await fetch(FEED_URL, {
    headers: {
      'Accept': 'application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'User-Agent': 'WeatherWise-MeteoAlarm-Proxy/1.0'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!upstream.ok) throw new Error(`MeteoAlarm HTTP ${upstream.status}`);
  const body = await upstream.text();
  if (!body.trim() || !body.includes('<')) throw new Error('Empty or invalid MeteoAlarm feed');

  cachedFeed = body;
  cachedAt = now;
  lastGoodFeed = body;
  return { body, cache: 'MISS', stale: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, JSON.stringify({
      ok: true,
      service: 'weatherwise-meteoalarm-proxy',
      cacheTtlSeconds: CACHE_MS / 1000
    }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && url.pathname === '/api/meteoalarm') {
    try {
      const result = await getMeteoAlarmFeed();
      return send(res, 200, result.body, {
        'Content-Type': 'application/atom+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'X-WeatherWise-Cache': result.cache
      });
    } catch (err) {
      // If the upstream is temporarily unavailable, serve the last known good
      // feed rather than showing an empty alerts panel.
      if (lastGoodFeed) {
        return send(res, 200, lastGoodFeed, {
          'Content-Type': 'application/atom+xml; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-WeatherWise-Cache': 'STALE',
          'Warning': '110 - "Serving stale MeteoAlarm feed"'
        });
      }
      return send(res, 502, JSON.stringify({
        error: 'MeteoAlarm feed temporarily unavailable',
        detail: err.message
      }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { 'Allow': 'GET, HEAD' });
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WeatherWise listening on ${PORT}`);
});

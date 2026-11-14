const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
let openMeteoClientPromise;

const PORT = Number(process.env.PORT || 3000);
const FEED_URL = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece';
const CACHE_MS = 5 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

let cachedFeed = null;
let cachedAt = 0;
let lastGoodFeed = null;


const weatherCache = new Map();
const weatherInflight = new Map();
const WEATHER_CACHE_MS = 2 * 60 * 1000;

async function cachedOpenMeteoJson(cacheKey, url, ttl = WEATHER_CACHE_MS) {
  const now = Date.now();
  const hit = weatherCache.get(cacheKey);
  if (hit && now - hit.at < ttl) return { data: hit.data, cache: 'HIT' };
  if (weatherInflight.has(cacheKey)) {
    const data = await weatherInflight.get(cacheKey);
    return { data, cache: 'COALESCED' };
  }
  const task = (async () => {
    const upstream = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'WeatherWise/1.0' },
      signal: AbortSignal.timeout(25000)
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      const err = new Error(`Open-Meteo HTTP ${upstream.status}: ${detail}`);
      err.status = upstream.status;
      throw err;
    }
    const data = await upstream.json();
    if (data && data.error) throw new Error(data.reason || 'Open-Meteo API error');
    weatherCache.set(cacheKey, { data, at: Date.now() });
    return data;
  })();
  weatherInflight.set(cacheKey, task);
  try {
    const data = await task;
    return { data, cache: 'MISS' };
  } finally {
    weatherInflight.delete(cacheKey);
  }
}

function safeForecastQuery(url) {
  const allowed = new Set([
    'latitude','longitude','current','hourly','daily','forecast_days',
    'forecast_hours','past_hours','timezone','wind_speed_unit',
    'models','temporal_resolution','cell_selection'
  ]);
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (allowed.has(key)) params.set(key, value);
  }
  if (!params.has('latitude') || !params.has('longitude')) {
    throw new Error('latitude and longitude are required');
  }
  return params.toString();
}

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


async function getOpenMeteoClient() {
  if (!openMeteoClientPromise) openMeteoClientPromise = import('openmeteo');
  return openMeteoClientPromise;
}


function runEcmwfWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.env.PYTHON_BIN || 'python3', [
      path.join(__dirname, 'ecmwf_worker.py')
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.on('error', reject);
    worker.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.slice(-1800) || `ECMWF worker exited ${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch (err) { reject(new Error(`Invalid ECMWF worker response: ${err.message}; ${stderr.slice(-500)}`)); }
    });
    worker.stdin.end(JSON.stringify(payload));
  });
}

async function getEcmwfGrid(url) {
  const latitudes = (url.searchParams.get('latitude') || '').split(',').map(Number);
  const longitudes = (url.searchParams.get('longitude') || '').split(',').map(Number);
  const fields = (url.searchParams.get('hourly') || '').split(',').filter(Boolean);
  if (!latitudes.length || latitudes.length !== longitudes.length ||
      latitudes.some(v => !Number.isFinite(v) || Math.abs(v) > 90) ||
      longitudes.some(v => !Number.isFinite(v) || Math.abs(v) > 180)) {
    throw new Error('Invalid latitude/longitude coordinates');
  }
  if (latitudes.length > 400) throw new Error('Maximum 400 coordinates per request');
  const allowed = new Set([
    'temperature_2m','precipitation','rain','pressure_msl','cloud_cover',
    'wind_speed_10m','wind_direction_10m','wind_gusts_10m','cape',
    'temperature_850hPa','temperature_500hPa'
  ]);
  if (!fields.length || fields.some(f => !allowed.has(f))) throw new Error('Unsupported ECMWF variable');
  const step = Math.max(0, Math.min(240, Number(url.searchParams.get('step') || 24)));
  if (!Number.isFinite(step)) throw new Error('Invalid forecast step');
  return runEcmwfWorker({ latitudes, longitudes, fields, step });
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



  if (req.method === 'GET' && (url.pathname === '/api/weather' || url.pathname === '/api/gfs')) {
    try {
      const query = safeForecastQuery(url);
      const endpoint = url.pathname === '/api/gfs'
        ? 'https://api.open-meteo.com/v1/gfs'
        : 'https://api.open-meteo.com/v1/forecast';
      const key = url.pathname + '?' + query;
      const result = await cachedOpenMeteoJson(key, endpoint + '?' + query, 120000);
      return send(res, 200, JSON.stringify(result.data), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120',
        'X-WeatherWise-Cache': result.cache,
        'Access-Control-Allow-Origin': '*'
      });
    } catch (err) {
      const status = err.status === 429 ? 503 : 502;
      return send(res, status, JSON.stringify({
        error: 'Open-Meteo data temporarily unavailable',
        detail: err.message
      }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/ecmwf') {
    try {
      const key = 'ecmwf?' + url.searchParams.toString();
      const cached = weatherCache.get(key);
      let items;
      if (cached && Date.now() - cached.at < WEATHER_CACHE_MS) items = cached.data;
      else if (weatherInflight.has(key)) items = await weatherInflight.get(key);
      else {
        const task = getEcmwfGrid(url).then(data => { weatherCache.set(key, { data, at: Date.now() }); return data; });
        weatherInflight.set(key, task);
        try { items = await task; } finally { weatherInflight.delete(key); }
      }
      return send(res, 200, JSON.stringify(items), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120',
        'Access-Control-Allow-Origin': '*',
        'X-WeatherWise-Provider': 'ECMWF Open Data'
      });
    } catch (err) {
      console.error('[ECMWF Open Data]', err && err.stack ? err.stack : err);
      return send(res, 502, JSON.stringify({
        error: 'Direct ECMWF Open Data temporarily unavailable',
        detail: String(err && err.message || err),
        hint: 'Check Render logs for [ECMWF Open Data]'
      }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/ecds/status') {
    const configured = Boolean(process.env.CDSAPI_URL && process.env.CDSAPI_KEY);
    return send(res, 200, JSON.stringify({
      configured,
      endpoint: configured ? process.env.CDSAPI_URL : null,
      service: 'ECMWF Data Store (ECDS)',
      note: configured
        ? 'Credentials detected. Dataset Terms of Use must be accepted in the ECDS website before retrieval.'
        : 'Set CDSAPI_URL and CDSAPI_KEY in the hosting environment.'
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

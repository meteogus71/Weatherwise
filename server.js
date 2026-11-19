const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const FEED_URL = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece';
const CACHE_MS = 5 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

let cachedFeed = null;
let cachedAt = 0;
let lastGoodFeed = null;


const weatherCache = new Map();
const weatherInflight = new Map();
// Keep ECMWF output separate and small: GRIB-derived grids can be large.
const ecmwfCache = new Map();
const ecmwfInflight = new Map();
let ecmwfQueue = Promise.resolve();
const MAX_WEATHER_CACHE_ENTRIES = 60;
const MAX_ECMWF_CACHE_ENTRIES = 2;

function setBoundedCache(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

function runEcmwfWorkerSerialized(payload) {
  const task = ecmwfQueue.then(() => runEcmwfWorker(payload));
  ecmwfQueue = task.catch(() => undefined);
  return task;
}
const WEATHER_CACHE_MS = 30 * 60 * 1000;
const WEATHER_STALE_MAX_MS = 24 * 60 * 60 * 1000;
const WEATHER_DISK_CACHE_DIR = '/tmp/weatherwise-api-cache';
try { fs.mkdirSync(WEATHER_DISK_CACHE_DIR, { recursive: true }); } catch {}

function weatherDiskPath(cacheKey) {
  const hash = require('node:crypto').createHash('sha256').update(cacheKey).digest('hex');
  return path.join(WEATHER_DISK_CACHE_DIR, `${hash}.json`);
}

async function readWeatherDiskCache(cacheKey) {
  try {
    const raw = await fs.promises.readFile(weatherDiskPath(cacheKey), 'utf8');
    const item = JSON.parse(raw);
    if (item && item.data && Number.isFinite(item.at)) {
      setBoundedCache(weatherCache, cacheKey, item, MAX_WEATHER_CACHE_ENTRIES);
      return item;
    }
  } catch {}
  return null;
}

async function writeWeatherDiskCache(cacheKey, item) {
  try {
    await fs.promises.writeFile(weatherDiskPath(cacheKey), JSON.stringify(item));
  } catch (err) {
    console.warn('[Weather cache] Could not persist cache:', err.message);
  }
}

async function cachedOpenMeteoJson(cacheKey, url, ttl = WEATHER_CACHE_MS) {
  const now = Date.now();
  let hit = weatherCache.get(cacheKey);
  if (!hit) hit = await readWeatherDiskCache(cacheKey);

  if (hit && now - hit.at < ttl) return { data: hit.data, cache: 'HIT' };
  if (weatherInflight.has(cacheKey)) {
    const result = await weatherInflight.get(cacheKey);
    return { data: result.data || result, cache: 'COALESCED' };
  }

  const task = (async () => {
    try {
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
      const item = { data, at: Date.now() };
      setBoundedCache(weatherCache, cacheKey, item, MAX_WEATHER_CACHE_ENTRIES);
      await writeWeatherDiskCache(cacheKey, item);
      return { data, cache: 'MISS' };
    } catch (err) {
      if (hit && now - hit.at <= WEATHER_STALE_MAX_MS) {
        console.warn(`[Weather cache] Serving stale data after upstream error: ${err.message}`);
        return { data: hit.data, cache: 'STALE', staleReason: err.message };
      }
      throw err;
    }
  })();

  weatherInflight.set(cacheKey, task);
  try {
    return await task;
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
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
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
  const latitudeParam = url.searchParams.get('latitude');
  const longitudeParam = url.searchParams.get('longitude');
  if (!latitudeParam || !longitudeParam) throw new Error('latitude and longitude are required');
  const latitudes = latitudeParam.split(',').map(Number);
  const longitudes = longitudeParam.split(',').map(Number);
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
  return runEcmwfWorkerSerialized({ latitudes, longitudes, fields, step });
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


// --------------------------------------------------
// MET NORWAY LOCATIONFORECAST ADAPTER
// --------------------------------------------------
const METNORWAY_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const METNORWAY_USER_AGENT = 'WeatherWise/1.0 (https://weatherwise-mkfx.onrender.com)';
const METNORWAY_CACHE_MS = 3 * 60 * 60 * 1000;

function metCacheKey(lat, lon) {
  // MET Norway recommends no more than four decimal places for coordinates.
  return `metno:${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

function metSymbolToWmo(symbol = '') {
  const s = String(symbol).toLowerCase().replace(/_day|_night|_polartwilight/g, '');
  if (s.startsWith('thunder')) return  thunderCode(s);
  if (s.startsWith('heavyrain')) return 65;
  if (s.startsWith('rainshowers')) return s.includes('heavy') ? 82 : (s.includes('light') ? 80 : 81);
  if (s.startsWith('rain')) return s.includes('heavy') ?  heavyRainCode(s) : (s.includes('light') ? 61 : 63);
  if (s.startsWith('sleet')) return  sleetCode(s);
  if (s.startsWith('snowshowers')) return s.includes('heavy') ? 86 : (s.includes('light') ? 85 : 85);
  if (s.startsWith('snow')) return s.includes('heavy') ? 75 : (s.includes('light') ? 71 : 73);
  if (s.startsWith('fog')) return 45;
  if (s === 'clearsky') return 0;
  if (s === 'fair') return 1;
  if (s === 'partlycloudy') return 2;
  if (s === 'cloudy') return 3;
  return 3;
}
function thunderCode(s) { return s.includes('heavy') ? 99 : 95; }
function heavyRainCode(s) { return s.includes('heavy') ? 65 : 63; }
function sleetCode(s) { return s.includes('heavy') ? 67 : 66; }

function metDetails(entry) {
  return entry?.data?.instant?.details || {};
}
function metPeriod(entry) {
  return entry?.data?.next_1_hours || entry?.data?.next_6_hours || entry?.data?.next_12_hours || null;
}

function buildMetNorwayOpenMeteoShape(raw, requested) {
  const series = raw?.properties?.timeseries || [];
  if (!series.length) throw new Error('MET Norway returned an empty forecast');

  const times = series.map(x => x.time);
  const currentEntry = series[0];
  const cur = metDetails(currentEntry);
  const currentPeriod = metPeriod(currentEntry);
  const symbol = currentPeriod?.summary?.symbol_code || currentEntry?.data?.next_6_hours?.summary?.symbol_code || '';
  const current = {
    time: currentEntry.time,
    temperature_2m: cur.air_temperature ?? null,
    relative_humidity_2m: cur.relative_humidity ?? null,
    apparent_temperature: cur.air_temperature ?? null,
    is_day: 1,
    precipitation: currentPeriod?.details?.precipitation_amount ?? 0,
    weather_code: metSymbolToWmo(symbol),
    wind_speed_10m: cur.wind_speed != null ? cur.wind_speed * 3.6 : null,
    wind_direction_10m: cur.wind_from_direction ?? null,
    surface_pressure: cur.air_pressure_at_sea_level ?? null
  };

  const hourly = {
    time: [], temperature_2m: [], apparent_temperature: [],
    relative_humidity_2m: [], dew_point_2m: [], cloud_cover: [],
    precipitation: [], precipitation_probability: [],
    wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: []
  };

  for (const entry of series) {
    const d = metDetails(entry);
    const period = metPeriod(entry);
    hourly.time.push(entry.time);
    hourly.temperature_2m.push(d.air_temperature ?? null);
    hourly.apparent_temperature.push(d.air_temperature ?? null);
    hourly.relative_humidity_2m.push(d.relative_humidity ?? null);
    hourly.dew_point_2m.push(d.dew_point_temperature ?? null);
    hourly.cloud_cover.push(d.cloud_area_fraction ?? null);
    hourly.precipitation.push(period?.details?.precipitation_amount ?? 0);
    hourly.precipitation_probability.push(Number.isFinite(period?.details?.probability_of_precipitation) ? period.details.probability_of_precipitation : null);
    hourly.wind_speed_10m.push(d.wind_speed != null ? d.wind_speed * 3.6 : null);
    hourly.wind_direction_10m.push(d.wind_from_direction ?? null);
    hourly.wind_gusts_10m.push(d.wind_speed_of_gust != null ? d.wind_speed_of_gust * 3.6 : null);
  }

  const dayMap = new Map();
  for (let i = 0; i < series.length; i++) {
    const entry = series[i];
    const date = entry.time.slice(0, 10);
    const d = metDetails(entry);
    const period = metPeriod(entry);
    if (!dayMap.has(date)) {
      dayMap.set(date, {
        temps: [], rain: 0, rainProb: [], winds: [], gusts: [], directions: [],
        weather_code: metSymbolToWmo(period?.summary?.symbol_code || '')
      });
    }
    const day = dayMap.get(date);
    if (Number.isFinite(d.air_temperature)) day.temps.push(d.air_temperature);
    if (Number.isFinite(period?.details?.precipitation_amount)) day.rain += period.details.precipitation_amount;
    if (Number.isFinite(period?.details?.probability_of_precipitation)) day.rainProb.push(period.details.probability_of_precipitation);
    if (Number.isFinite(d.wind_speed)) day.winds.push(d.wind_speed * 3.6);
    if (Number.isFinite(d.wind_speed_of_gust)) day.gusts.push(d.wind_speed_of_gust * 3.6);
    if (Number.isFinite(d.wind_from_direction)) day.directions.push(d.wind_from_direction);
  }

  const dailyEntries = [...dayMap.entries()].slice(0, 7);
  const daily = {
    time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
    precipitation_probability_max: [], precipitation_sum: [], wind_speed_10m_max: [],
    wind_gusts_10m_max: [], wind_direction_10m_dominant: [], uv_index_max: []
  };
  for (const [date, day] of dailyEntries) {
    daily.time.push(date);
    daily.weather_code.push(day.weather_code);
    daily.temperature_2m_max.push(day.temps.length ? Math.max(...day.temps) : null);
    daily.temperature_2m_min.push(day.temps.length ? Math.min(...day.temps) : null);
    daily.precipitation_probability_max.push(day.rainProb.length ? Math.max(...day.rainProb) : null);
    daily.precipitation_sum.push(Number(day.rain.toFixed(2)));
    daily.wind_speed_10m_max.push(day.winds.length ? Math.max(...day.winds) : null);
    daily.wind_gusts_10m_max.push(day.gusts.length ? Math.max(...day.gusts) : null);
    daily.wind_direction_10m_dominant.push(day.directions.length ? day.directions[0] : null);
    daily.uv_index_max.push(null);
  }

  return {
    latitude: raw.geometry?.coordinates?.[1] ?? null,
    longitude: raw.geometry?.coordinates?.[0] ?? null,
    timezone: 'UTC', timezone_abbreviation: 'UTC', utc_offset_seconds: 0,
    current, hourly, daily,
    _provider: 'MET Norway Locationforecast',
    _updated_at: raw.properties?.meta?.updated_at || null
  };
}


async function getOpenMeteoPrecipitationProbability(lat, lon) {
  const params = new URLSearchParams({
    latitude: Number(lat).toFixed(4),
    longitude: Number(lon).toFixed(4),
    hourly: 'precipitation_probability',
    daily: 'precipitation_probability_max',
    forecast_days: '7',
    timezone: 'UTC'
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'WeatherWise/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Open-Meteo precipitation probability HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.reason || 'Open-Meteo precipitation probability error');
  return payload;
}

function mergePrecipitationProbability(target, probability) {
  if (!target?.hourly || !target?.daily || !probability?.hourly || !probability?.daily) return target;
  const hourlyByTime = new Map();
  (probability.hourly.time || []).forEach((time, i) => {
    const value = probability.hourly.precipitation_probability?.[i];
    if (Number.isFinite(value)) hourlyByTime.set(Date.parse(`${time}:00Z`), value);
  });
  target.hourly.precipitation_probability = (target.hourly.time || []).map(time => {
    const value = hourlyByTime.get(Date.parse(time));
    return Number.isFinite(value) ? value : null;
  });

  const dailyByDate = new Map();
  (probability.daily.time || []).forEach((date, i) => {
    const value = probability.daily.precipitation_probability_max?.[i];
    if (Number.isFinite(value)) dailyByDate.set(String(date).slice(0, 10), value);
  });
  target.daily.precipitation_probability_max = (target.daily.time || []).map(date => {
    const value = dailyByDate.get(String(date).slice(0, 10));
    return Number.isFinite(value) ? value : null;
  });
  target._precipitation_probability_provider = 'Open-Meteo';
  return target;
}

async function getMetNorwayPoint(lat, lon) {
  const key = metCacheKey(lat, lon);
  let hit = weatherCache.get(key);
  if (!hit) hit = await readWeatherDiskCache(key);
  if (hit && Date.now() - hit.at < METNORWAY_CACHE_MS) return hit.data;
  if (weatherInflight.has(key)) return weatherInflight.get(key);

  const task = (async () => {
    const params = new URLSearchParams({ lat: Number(lat).toFixed(4), lon: Number(lon).toFixed(4) });
    const response = await fetch(`${METNORWAY_URL}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': METNORWAY_USER_AGENT },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      const err = new Error(`MET Norway HTTP ${response.status}: ${detail}`);
      err.status = response.status;
      throw err;
    }
    const raw = await response.json();
    const data = buildMetNorwayOpenMeteoShape(raw);
    try {
      const probability = await getOpenMeteoPrecipitationProbability(lat, lon);
      mergePrecipitationProbability(data, probability);
    } catch (probabilityError) {
      console.warn('[Precipitation probability] Open-Meteo enrichment unavailable:', probabilityError.message);
      // Keep missing values as null; never report a false 0% probability.
    }
    const item = { data, at: Date.now() };
    setBoundedCache(weatherCache, key, item, MAX_WEATHER_CACHE_ENTRIES);
    await writeWeatherDiskCache(key, item);
    return data;
  })();

  weatherInflight.set(key, task);
  try {
    return await task;
  } catch (err) {
    if (hit && Date.now() - hit.at <= WEATHER_STALE_MAX_MS) {
      console.warn(`[MET Norway] Serving stale forecast: ${err.message}`);
      return hit.data;
    }
    throw err;
  } finally {
    weatherInflight.delete(key);
  }
}

async function getMetNorwayWeather(url) {
  const latitudeParam = url.searchParams.get('latitude');
  const longitudeParam = url.searchParams.get('longitude');
  if (!latitudeParam || !longitudeParam) throw new Error('latitude and longitude are required');
  const latitudes = latitudeParam.split(',').map(Number);
  const longitudes = longitudeParam.split(',').map(Number);
  if (!latitudes.length || latitudes.length !== longitudes.length ||
      latitudes.some(v => !Number.isFinite(v) || Math.abs(v) > 90) ||
      longitudes.some(v => !Number.isFinite(v) || Math.abs(v) > 180)) {
    throw new Error('Invalid latitude/longitude coordinates');
  }
  if (latitudes.length > 40) throw new Error('Maximum 40 coordinates per request');
  // Keep upstream requests bounded: a first page load can request many cities.
  const results = new Array(latitudes.length);
  let nextIndex = 0;
  const workerCount = Math.min(3, latitudes.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= latitudes.length) return;
      results[i] = await getMetNorwayPoint(latitudes[i], longitudes[i]);
    }
  }));
  return latitudes.length === 1 ? results[0] : results;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, JSON.stringify({
      ok: true,
      service: 'weatherwise-api',
      weatherProvider: 'MET Norway Locationforecast',
      cacheTtlSeconds: CACHE_MS / 1000
    }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }



  if (req.method === 'GET' && url.pathname === '/api/weather') {
    try {
      const data = await getMetNorwayWeather(url);
      return send(res, 200, JSON.stringify(data), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-WeatherWise-Provider': 'MET Norway Locationforecast',
        'Access-Control-Allow-Origin': '*'
      });
    } catch (err) {
      console.error('[MET Norway]', err);
      return send(res, err.status === 403 ? 502 : 503, JSON.stringify({
        error: 'MET Norway weather data temporarily unavailable',
        detail: err.message
      }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/gfs') {
    try {
      const query = safeForecastQuery(url);
      const key = url.pathname + '?' + query;
      const result = await cachedOpenMeteoJson(key, 'https://api.open-meteo.com/v1/gfs?' + query, WEATHER_CACHE_MS);
      return send(res, 200, JSON.stringify(result.data), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120',
        'X-WeatherWise-Cache': result.cache,
        'Access-Control-Allow-Origin': '*'
      });
    } catch (err) {
      return send(res, err.status === 429 ? 503 : 502, JSON.stringify({
        error: 'GFS data temporarily unavailable', detail: err.message
      }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/ecmwf') {
    try {
      const key = 'ecmwf?' + url.searchParams.toString();
      const cached = ecmwfCache.get(key);
      let items;
      if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
        // Refresh LRU position on hit.
        ecmwfCache.delete(key);
        ecmwfCache.set(key, cached);
        items = cached.data;
      } else if (ecmwfInflight.has(key)) {
        items = await ecmwfInflight.get(key);
      } else {
        const task = getEcmwfGrid(url).then(data => {
          setBoundedCache(ecmwfCache, key, { data, at: Date.now() }, MAX_ECMWF_CACHE_ENTRIES);
          return data;
        });
        ecmwfInflight.set(key, task);
        try { items = await task; } finally { ecmwfInflight.delete(key); }
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

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
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

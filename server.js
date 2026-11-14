
const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  // HEALTH
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, JSON.stringify({
      ok: true,
      service: 'weatherwise-api',
      weatherProvider: 'MET Norway Locationforecast',
      cacheTtlSeconds: CACHE_MS / 1000
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  // CURRENT WEATHER AND FORECAST - MET NORWAY
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

      return send(
        res,
        err.status === 403 ? 502 : 503,
        JSON.stringify({
          error: 'MET Norway weather data temporarily unavailable',
          detail: err.message
        }),
        {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      );
    }
  }

  // GFS - TEMPORARILY STILL OPEN-METEO
  if (req.method === 'GET' && url.pathname === '/api/gfs') {
    try {
      const query = safeForecastQuery(url);
      const key = url.pathname + '?' + query;

      const result = await cachedOpenMeteoJson(
        key,
        'https://api.open-meteo.com/v1/gfs?' + query,
        WEATHER_CACHE_MS
      );

      return send(res, 200, JSON.stringify(result.data), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120',
        'X-WeatherWise-Cache': result.cache,
        'Access-Control-Allow-Origin': '*'
      });

    } catch (err) {
      return send(
        res,
        err.status === 429 ? 503 : 502,
        JSON.stringify({
          error: 'GFS data temporarily unavailable',
          detail: err.message
        }),
        {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      );
    }
  }

  // ECMWF
  if (req.method === 'GET' && url.pathname === '/api/ecmwf') {
    try {
      const key = 'ecmwf?' + url.searchParams.toString();
      const cached = weatherCache.get(key);

      let items;

      if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
        items = cached.data;

      } else if (weatherInflight.has(key)) {
        items = await weatherInflight.get(key);

      } else {
        const task = getEcmwfGrid(url).then(data => {
          weatherCache.set(key, { data, at: Date.now() });
          return data;
        });

        weatherInflight.set(key, task);

        try {
          items = await task;
        } finally {
          weatherInflight.delete(key);
        }
      }

      return send(res, 200, JSON.stringify(items), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120',
        'Access-Control-Allow-Origin': '*',
        'X-WeatherWise-Provider': 'ECMWF Open Data'
      });

    } catch (err) {
      console.error(
        '[ECMWF Open Data]',
        err && err.stack ? err.stack : err
      );

      return send(res, 502, JSON.stringify({
        error: 'Direct ECMWF Open Data temporarily unavailable',
        detail: String(err && err.message || err),
        hint: 'Check Render logs for [ECMWF Open Data]'
      }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
    }
  }

  // ECMWF DATA STORE STATUS
  if (req.method === 'GET' && url.pathname === '/api/ecds/status') {
    const configured = Boolean(
      process.env.CDSAPI_URL && process.env.CDSAPI_KEY
    );

    return send(res, 200, JSON.stringify({
      configured,
      endpoint: configured ? process.env.CDSAPI_URL : null,
      service: 'ECMWF Data Store (ECDS)',
      note: configured
        ? 'Credentials detected. Dataset Terms of Use must be accepted in the ECDS website before retrieval.'
        : 'Set CDSAPI_URL and CDSAPI_KEY in the hosting environment.'
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  // METEOALARM
  if (req.method === 'GET' && url.pathname === '/api/meteoalarm') {
    try {
      const result = await getMeteoAlarmFeed();

      return send(res, 200, result.body, {
        'Content-Type': 'application/atom+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'X-WeatherWise-Cache': result.cache
      });

    } catch (err) {
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
      }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
    }
  }

  // METHOD VALIDATION
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', {
      'Allow': 'GET, HEAD'
    });
  }

  // STATIC FILES
  let pathname;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');

    const type =
      MIME[path.extname(filePath).toLowerCase()] ||
      'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control':
        path.extname(filePath) === '.html'
          ? 'no-cache'
          : 'public, max-age=3600'
    });

    if (req.method === 'HEAD') return res.end();

    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WeatherWise listening on ${PORT}`);
});

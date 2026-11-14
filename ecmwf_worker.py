#!/usr/bin/env python3
"""Fetch and sample native ECMWF IFS Open Data GRIB fields for WeatherWise."""
import json, os, sys, tempfile, hashlib, datetime
from pathlib import Path

def main():
    req = json.load(sys.stdin)
    lats, lons = req["latitudes"], req["longitudes"]
    fields = req["fields"]
    step = int(req["step"])
    # ECMWF IFS 00/12 cycles: 3-hourly through 144h, then 6-hourly.
    if step > 144:
        step = int(round(step / 6) * 6)
    else:
        step = int(round(step / 3) * 3)

    from ecmwf.opendata import Client
    import eccodes

    cache_dir = Path(os.environ.get("ECMWF_CACHE_DIR", "/tmp/weatherwise-ecmwf"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha1(f"ifs-oper-fc-{step}".encode()).hexdigest()
    grib_path = cache_dir / f"{cache_key}.grib2"

    if not grib_path.exists() or grib_path.stat().st_size < 1000:
        tmp_path = grib_path.with_suffix(".part")
        # Use ECMWF's own Open Data distribution; no third-party weather API.
        client = Client(source=os.environ.get("ECMWF_OPEN_DATA_SOURCE", "ecmwf"), model="ifs", resol="0p25")
        client.retrieve(
            stream="oper", type="fc", step=step,
            param=["2t", "tp", "msl", "tcc", "10u", "10v", "cape"],
            target=str(tmp_path)
        )
        if not tmp_path.exists() or tmp_path.stat().st_size < 1000:
            raise RuntimeError("ECMWF Open Data returned an empty GRIB file")
        tmp_path.replace(grib_path)

    # Prepare a nearest-neighbour sampler for each requested coordinate.
    out = [{"latitude": la, "longitude": lo, "hourly": {"time": [], **{f: [] for f in fields}}}
           for la, lo in zip(lats, lons)]
    surface = {}
    pressure = {}
    with grib_path.open("rb") as stream:
        while True:
            gid = eccodes.codes_grib_new_from_file(stream)
            if gid is None:
                break
            try:
                short = eccodes.codes_get(gid, "shortName")
                level = int(eccodes.codes_get(gid, "level")) if eccodes.codes_is_defined(gid, "level") else 0
                if short in ("t",) and level in (500, 850):
                    pressure[(short, level)] = gid
                    # Keep handle alive until sampling is complete.
                    continue
                if short in ("2t", "tp", "msl", "tcc", "10u", "10v", "cape"):
                    surface[short] = gid
                    continue
                eccodes.codes_release(gid)
            except Exception:
                eccodes.codes_release(gid)
                raise

    # The surface file can be downloaded as a single multi-parameter GRIB.
    # Pressure-level fields are fetched only when explicitly requested.
    need_levels = []
    if "temperature_850hPa" in fields: need_levels.append(850)
    if "temperature_500hPa" in fields: need_levels.append(500)
    for lev in need_levels:
        if ("t", lev) not in pressure:
            pfile = cache_dir / f"{cache_key}-t{lev}.grib2"
            if not pfile.exists() or pfile.stat().st_size < 1000:
                tmp = pfile.with_suffix(".part")
                Client(source=os.environ.get("ECMWF_OPEN_DATA_SOURCE", "ecmwf"), model="ifs", resol="0p25").retrieve(
                    stream="oper", type="fc", step=step, levtype="pl", levelist=[lev],
                    param="t", target=str(tmp)
                )
                tmp.replace(pfile)
            with pfile.open("rb") as ps:
                while True:
                    gid = eccodes.codes_grib_new_from_file(ps)
                    if gid is None: break
                    if eccodes.codes_get(gid, "shortName") == "t":
                        pressure[("t", lev)] = gid
                    else:
                        eccodes.codes_release(gid)

    def nearest(gid, lat, lon):
        found = eccodes.codes_grib_find_nearest(gid, [lat], [lon])
        return float(found[0]["value"]) if found else None

    def valid_iso(gid):
        try:
            d = int(eccodes.codes_get(gid, "validityDate"))
            t = int(eccodes.codes_get(gid, "validityTime"))
            dt = datetime.datetime.strptime(f"{d:08d}{t:04d}", "%Y%m%d%H%M").replace(tzinfo=datetime.timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except Exception:
            return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=step)).isoformat().replace("+00:00", "Z")

    # Use a field message to derive the exact valid time.
    first_gid = next(iter(surface.values()), None) or next(iter(pressure.values()), None)
    timestamp = valid_iso(first_gid) if first_gid else ""
    for i, (lat, lon) in enumerate(zip(lats, lons)):
        raw = {k: nearest(gid, lat, lon) for k, gid in surface.items()}
        u, v = raw.get("10u"), raw.get("10v")
        speed_ms = ((u*u + v*v) ** 0.5) if u is not None and v is not None else None
        direction = ((270 - __import__("math").degrees(__import__("math").atan2(v, u))) % 360) if u is not None and v is not None else None
        values = {
            "temperature_2m": raw.get("2t") - 273.15 if raw.get("2t") is not None else None,
            "precipitation": raw.get("tp") * 1000 if raw.get("tp") is not None else None,
            "rain": raw.get("tp") * 1000 if raw.get("tp") is not None else None,
            "pressure_msl": raw.get("msl") / 100 if raw.get("msl") is not None else None,
            "cloud_cover": raw.get("tcc") * 100 if raw.get("tcc") is not None else None,
            "wind_speed_10m": speed_ms * 1.943844 if speed_ms is not None else None,
            "wind_direction_10m": direction,
            "wind_gusts_10m": None,
            "cape": raw.get("cape"),
            "temperature_850hPa": nearest(pressure[("t", 850)], lat, lon) - 273.15 if ("t",850) in pressure else None,
            "temperature_500hPa": nearest(pressure[("t", 500)], lat, lon) - 273.15 if ("t",500) in pressure else None,
        }
        out[i]["hourly"]["time"] = [timestamp]
        out[i]["hourly"]["interval"] = 3600
        for field in fields:
            out[i]["hourly"][field] = [values.get(field)]

    for gid in list(surface.values()) + list(pressure.values()):
        try: eccodes.codes_release(gid)
        except Exception: pass
    print(json.dumps(out, allow_nan=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ECMWF worker error: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)

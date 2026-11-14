#!/usr/bin/env python3
"""Fetch and sample ECMWF IFS Open Data GRIB fields for WeatherWise.

Memory-conscious implementation: GRIB messages are sampled and released one
at a time instead of retaining ecCodes handles for an entire file.
"""

import contextlib
import datetime
import hashlib
import json
import math
import os
import sys
import uuid
from pathlib import Path


def main():
    req = json.load(sys.stdin)
    lats = [float(x) for x in req["latitudes"]]
    lons = [float(x) for x in req["longitudes"]]
    fields = list(req["fields"])
    step = int(req["step"])

    if len(lats) != len(lons):
        raise ValueError("latitudes and longitudes must have equal length")

    # ECMWF IFS: 3-hourly through 144h, then 6-hourly.
    step = int(round(step / (6 if step > 144 else 3)) * (6 if step > 144 else 3))

    from ecmwf.opendata import Client
    import eccodes

    cache_dir = Path(os.environ.get("ECMWF_CACHE_DIR", "/tmp/weatherwise-ecmwf"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha1(f"ifs-oper-fc-{step}".encode()).hexdigest()
    cache_seconds = int(os.environ.get("ECMWF_CACHE_HOURS", "6")) * 3600

    def cache_is_valid(path):
        try:
            return path.is_file() and path.stat().st_size > 1000 and (
                datetime.datetime.now().timestamp() - path.stat().st_mtime < cache_seconds
            )
        except OSError:
            return False

    def download_grib(path, **kwargs):
        # Unique temp path prevents concurrent workers colliding on .part files.
        tmp_path = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.part")
        client = Client(
            source=os.environ.get("ECMWF_OPEN_DATA_SOURCE", "ecmwf"),
            model="ifs",
            resol="0p25",
        )
        try:
            # stdout is reserved for the JSON response read by server.js.
            with contextlib.redirect_stdout(sys.stderr):
                client.retrieve(
                    stream="oper", type="fc", step=step, target=str(tmp_path), **kwargs
                )
            if not tmp_path.exists() or tmp_path.stat().st_size < 1000:
                raise RuntimeError("ECMWF Open Data returned an empty GRIB file")
            os.replace(tmp_path, path)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def ensure_download(path, **kwargs):
        if not cache_is_valid(path):
            download_grib(path, **kwargs)

    def sample_grib(path, wanted, level=None):
        """Return sampled values by shortName; release each GRIB handle promptly."""
        sampled = {name: [None] * len(lats) for name in wanted}
        timestamp = ""
        with path.open("rb") as stream:
            while True:
                gid = eccodes.codes_grib_new_from_file(stream)
                if gid is None:
                    break
                try:
                    short = eccodes.codes_get(gid, "shortName")
                    if short not in wanted:
                        continue
                    if level is not None and int(eccodes.codes_get(gid, "level")) != level:
                        continue
                    if not timestamp:
                        try:
                            d = int(eccodes.codes_get(gid, "validityDate"))
                            t = int(eccodes.codes_get(gid, "validityTime"))
                            dt = datetime.datetime.strptime(
                                f"{d:08d}{t:04d}", "%Y%m%d%H%M"
                            ).replace(tzinfo=datetime.timezone.utc)
                            timestamp = dt.isoformat().replace("+00:00", "Z")
                        except Exception:
                            timestamp = (
                                datetime.datetime.now(datetime.timezone.utc)
                                + datetime.timedelta(hours=step)
                            ).isoformat().replace("+00:00", "Z")
                    values = sampled[short]
                    for i, (lat, lon) in enumerate(zip(lats, lons)):
                        nearest = eccodes.codes_grib_find_nearest(gid, lat, lon)
                        values[i] = float(nearest[0]["value"]) if nearest else None
                finally:
                    eccodes.codes_release(gid)
        return sampled, timestamp

    # Surface fields: one GRIB handle at a time; no retained ecCodes handles.
    surface_path = cache_dir / f"{cache_key}.grib2"
    ensure_download(surface_path, param=["2t", "tp", "msl", "tcc", "10u", "10v"])
    surface, timestamp = sample_grib(
        surface_path, {"2t", "tp", "msl", "tcc", "10u", "10v"}
    )

    pressure = {}
    for lev, field_name in ((850, "temperature_850hPa"), (500, "temperature_500hPa")):
        if field_name not in fields:
            continue
        pfile = cache_dir / f"{cache_key}-t{lev}.grib2"
        ensure_download(pfile, levtype="pl", levelist=[lev], param="t")
        sampled, pressure_timestamp = sample_grib(pfile, {"t"}, level=lev)
        pressure[lev] = sampled["t"]
        if not timestamp:
            timestamp = pressure_timestamp

    if not timestamp:
        timestamp = (
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=step)
        ).isoformat().replace("+00:00", "Z")

    out = []
    for i, (lat, lon) in enumerate(zip(lats, lons)):
        raw = {name: values[i] for name, values in surface.items()}
        u, v = raw.get("10u"), raw.get("10v")
        speed_ms = math.hypot(u, v) if u is not None and v is not None else None
        direction = (
            (270 - math.degrees(math.atan2(v, u))) % 360
            if u is not None and v is not None else None
        )
        values = {
            "temperature_2m": raw["2t"] - 273.15 if raw.get("2t") is not None else None,
            "precipitation": raw["tp"] * 1000 if raw.get("tp") is not None else None,
            "rain": raw["tp"] * 1000 if raw.get("tp") is not None else None,
            "pressure_msl": raw["msl"] / 100 if raw.get("msl") is not None else None,
            "cloud_cover": raw["tcc"] * 100 if raw.get("tcc") is not None else None,
            "wind_speed_10m": speed_ms * 1.943844 if speed_ms is not None else None,
            "wind_direction_10m": direction,
            "wind_gusts_10m": None,
            "cape": None,
            "temperature_850hPa": (
                pressure[850][i] - 273.15 if 850 in pressure and pressure[850][i] is not None else None
            ),
            "temperature_500hPa": (
                pressure[500][i] - 273.15 if 500 in pressure and pressure[500][i] is not None else None
            ),
        }
        hourly = {"time": [timestamp], "interval": 3600}
        for field in fields:
            hourly[field] = [values.get(field)]
        out.append({"latitude": lat, "longitude": lon, "hourly": hourly})

    print(json.dumps(out, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ECMWF worker error: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)

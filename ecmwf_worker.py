
#!/usr/bin/env python3
"""Fetch and sample native ECMWF IFS Open Data GRIB fields for WeatherWise."""

import json
import os
import sys
import hashlib
import datetime
import math
import contextlib
import uuid
from pathlib import Path


def main():
    req = json.load(sys.stdin)

    lats = req["latitudes"]
    lons = req["longitudes"]
    fields = req["fields"]
    step = int(req["step"])

    # ECMWF IFS: 3-hourly through 144h, then 6-hourly.
    if step > 144:
        step = int(round(step / 6) * 6)
    else:
        step = int(round(step / 3) * 3)

    from ecmwf.opendata import Client
    import eccodes

    cache_dir = Path(
        os.environ.get("ECMWF_CACHE_DIR", "/tmp/weatherwise-ecmwf")
    )
    cache_dir.mkdir(parents=True, exist_ok=True)

    cache_key = hashlib.sha1(
        f"ifs-oper-fc-{step}".encode()
    ).hexdigest()

    cache_hours = int(os.environ.get("ECMWF_CACHE_HOURS", "6"))
    cache_seconds = cache_hours * 3600

    def cache_is_valid(path):
        return (
            path.exists()
            and path.stat().st_size > 1000
            and (datetime.datetime.now().timestamp() - path.stat().st_mtime)
            < cache_seconds
        )

    def download_grib(path, **kwargs):
        # Each worker process gets its own temporary filename. This prevents
        # simultaneous requests for the same forecast step from deleting or
        # replacing one another's .part file.
        tmp_path = path.with_name(
            f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.part"
        )

        client = Client(
            source=os.environ.get("ECMWF_OPEN_DATA_SOURCE", "ecmwf"),
            model="ifs",
            resol="0p25"
        )

        try:
            # The Open Data client may print download/progress messages.
            # Keep stdout reserved for the single JSON response consumed by
            # server.js; send all library output to stderr instead.
            with contextlib.redirect_stdout(sys.stderr):
                client.retrieve(
                    stream="oper",
                    type="fc",
                    step=step,
                    target=str(tmp_path),
                    **kwargs
                )

            if not tmp_path.exists() or tmp_path.stat().st_size < 1000:
                raise RuntimeError(
                    "ECMWF Open Data returned an empty GRIB file"
                )

            # Atomic replacement ensures readers never see a partial GRIB.
            os.replace(tmp_path, path)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    # Download surface fields if cache is missing or expired.
    grib_path = cache_dir / f"{cache_key}.grib2"

    if not cache_is_valid(grib_path):
        download_grib(
            grib_path,
            param=["2t", "tp", "msl", "tcc", "10u", "10v"]
        )

    # Prepare output.
    out = [
        {
            "latitude": la,
            "longitude": lo,
            "hourly": {
                "time": [],
                **{field: [] for field in fields}
            }
        }
        for la, lo in zip(lats, lons)
    ]

    surface = {}
    pressure = {}

    # Read surface GRIB fields.
    with grib_path.open("rb") as stream:
        while True:
            gid = eccodes.codes_grib_new_from_file(stream)

            if gid is None:
                break

            try:
                short = eccodes.codes_get(gid, "shortName")

                if short in ("2t", "tp", "msl", "tcc", "10u", "10v"):
                    surface[short] = gid
                else:
                    eccodes.codes_release(gid)

            except Exception:
                eccodes.codes_release(gid)
                raise

    # Download pressure-level fields only when requested.
    need_levels = []

    if "temperature_850hPa" in fields:
        need_levels.append(850)

    if "temperature_500hPa" in fields:
        need_levels.append(500)

    for lev in need_levels:
        if ("t", lev) not in pressure:

            pfile = cache_dir / f"{cache_key}-t{lev}.grib2"

            if not cache_is_valid(pfile):
                download_grib(
                    pfile,
                    levtype="pl",
                    levelist=[lev],
                    param="t"
                )

            with pfile.open("rb") as ps:
                while True:
                    gid = eccodes.codes_grib_new_from_file(ps)

                    if gid is None:
                        break

                    try:
                        short = eccodes.codes_get(gid, "shortName")
                        level = int(eccodes.codes_get(gid, "level"))

                        if short == "t" and level == lev:
                            pressure[("t", lev)] = gid
                        else:
                            eccodes.codes_release(gid)

                    except Exception:
                        eccodes.codes_release(gid)
                        raise

    # Sample the nearest grid point.
    def nearest(gid, lat, lon):
        found = eccodes.codes_grib_find_nearest(
            gid,
            float(lat),
            float(lon)
        )

        return float(found[0]["value"]) if found else None

    def valid_iso(gid):
        try:
            d = int(eccodes.codes_get(gid, "validityDate"))
            t = int(eccodes.codes_get(gid, "validityTime"))

            dt = datetime.datetime.strptime(
                f"{d:08d}{t:04d}",
                "%Y%m%d%H%M"
            ).replace(tzinfo=datetime.timezone.utc)

            return dt.isoformat().replace("+00:00", "Z")

        except Exception:
            return (
                datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(hours=step)
            ).isoformat().replace("+00:00", "Z")

    # Get forecast valid time.
    first_gid = (
        next(iter(surface.values()), None)
        or next(iter(pressure.values()), None)
    )

    timestamp = valid_iso(first_gid) if first_gid else ""

    # Calculate values for each requested coordinate.
    for i, (lat, lon) in enumerate(zip(lats, lons)):

        raw = {
            key: nearest(gid, lat, lon)
            for key, gid in surface.items()
        }

        u = raw.get("10u")
        v = raw.get("10v")

        speed_ms = (
            math.sqrt(u * u + v * v)
            if u is not None and v is not None
            else None
        )

        direction = (
            (270 - math.degrees(math.atan2(v, u))) % 360
            if u is not None and v is not None
            else None
        )

        t850 = (
            nearest(pressure[("t", 850)], lat, lon)
            if ("t", 850) in pressure
            else None
        )

        t500 = (
            nearest(pressure[("t", 500)], lat, lon)
            if ("t", 500) in pressure
            else None
        )

        values = {
            "temperature_2m": (
                raw.get("2t") - 273.15
                if raw.get("2t") is not None else None
            ),

            "precipitation": (
                raw.get("tp") * 1000
                if raw.get("tp") is not None else None
            ),

            "rain": (
                raw.get("tp") * 1000
                if raw.get("tp") is not None else None
            ),

            "pressure_msl": (
                raw.get("msl") / 100
                if raw.get("msl") is not None else None
            ),

            "cloud_cover": (
                raw.get("tcc") * 100
                if raw.get("tcc") is not None else None
            ),

            "wind_speed_10m": (
                speed_ms * 1.943844
                if speed_ms is not None else None
            ),

            "wind_direction_10m": direction,
            "wind_gusts_10m": None,

            # CAPE temporarily unavailable in this GRIB request.
            "cape": None,

            "temperature_850hPa": (
                t850 - 273.15 if t850 is not None else None
            ),

            "temperature_500hPa": (
                t500 - 273.15 if t500 is not None else None
            ),
        }

        out[i]["hourly"]["time"] = [timestamp]
        out[i]["hourly"]["interval"] = 3600

        for field in fields:
            out[i]["hourly"][field] = [values.get(field)]

    # Release GRIB handles.
    for gid in list(surface.values()) + list(pressure.values()):
        try:
            eccodes.codes_release(gid)
        except Exception:
            pass

    print(json.dumps(out, allow_nan=False))


if __name__ == "__main__":
    try:
        main()

    except Exception as exc:
        print(
            f"ECMWF worker error: {type(exc).__name__}: {exc}",
            file=sys.stderr
        )
        sys.exit(1)

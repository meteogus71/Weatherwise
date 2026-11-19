#!/usr/bin/env python3
"""Diagnostic sampler for ECMWF AIFS ENS 24-hour precipitation probabilities.

Fetches the official AIFS ENS probability product tpg1 (>= 1 mm / 24 h),
then samples the nearest grid point for one latitude/longitude. The output is
kept separate from WeatherWise's hourly probability curve until validated.
"""
import contextlib
import datetime as dt
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path

STEPS = ["72-96", "96-120", "120-144", "144-168"]
PARAM = "tpg1"


def main():
    req = json.load(sys.stdin)
    lat = float(req["latitude"])
    lon = float(req["longitude"])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Invalid coordinates")

    from ecmwf.opendata import Client
    import eccodes

    cache_dir = Path(os.environ.get("ECMWF_CACHE_DIR", "/tmp/weatherwise-ecmwf-aifs"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha256((PARAM + ":" + ",".join(STEPS)).encode()).hexdigest()[:20]
    target = cache_dir / f"aifs-ens-{cache_key}.grib2"
    cache_hours = max(1, int(os.environ.get("AIFS_PROBABILITY_CACHE_HOURS", "6")))

    fresh = target.is_file() and target.stat().st_size > 1000 and (
        dt.datetime.now(dt.timezone.utc).timestamp() - target.stat().st_mtime < cache_hours * 3600
    )
    if not fresh:
        tmp = target.with_name(f"{target.name}.{os.getpid()}.{uuid.uuid4().hex}.part")
        errors = []
        downloaded = False
        # ECMWF probability products are disseminated for 00 and 12 UTC cycles.
        # Try 12 UTC first, then 00 UTC; the client selects the latest available date.
        for cycle in (12, 0):
            try:
                client = Client(source=os.environ.get("ECMWF_OPEN_DATA_SOURCE", "ecmwf"), model="aifs-ens")
                with contextlib.redirect_stdout(sys.stderr):
                    client.retrieve(
                        time=cycle,
                        stream="enfo",
                        type="ep",
                        step=STEPS,
                        param=[PARAM],
                        target=str(tmp),
                    )
                if not tmp.exists() or tmp.stat().st_size < 1000:
                    raise RuntimeError("ECMWF returned an empty AIFS ENS GRIB2 file")
                os.replace(tmp, target)
                downloaded = True
                break
            except Exception as exc:
                errors.append(f"cycle {cycle:02d}Z: {type(exc).__name__}: {exc}")
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
        if not downloaded:
            raise RuntimeError("AIFS ENS download failed; " + " | ".join(errors[-2:]))

    periods = {}
    run_time = None
    with target.open("rb") as stream:
        while True:
            gid = eccodes.codes_grib_new_from_file(stream)
            if gid is None:
                break
            try:
                short_name = str(eccodes.codes_get(gid, "shortName"))
                if short_name != PARAM:
                    continue
                step_range = str(eccodes.codes_get(gid, "stepRange"))
                if step_range not in STEPS:
                    continue
                units = str(eccodes.codes_get(gid, "units"))
                data_date = int(eccodes.codes_get(gid, "dataDate"))
                data_time = int(eccodes.codes_get(gid, "dataTime"))
                run_dt = dt.datetime.strptime(f"{data_date:08d}{data_time:04d}", "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
                run_time = run_dt.isoformat().replace("+00:00", "Z")
                nearest = eccodes.codes_grib_find_nearest(gid, lat, lon)
                value = float(nearest[0]["value"]) if nearest else None
                start_h, end_h = [int(x) for x in step_range.split("-")]
                start_dt = run_dt + dt.timedelta(hours=start_h)
                end_dt = run_dt + dt.timedelta(hours=end_h)
                periods[step_range] = {
                    "start_step_hours": start_h,
                    "end_step_hours": end_h,
                    "start_utc": start_dt.isoformat().replace("+00:00", "Z"),
                    "end_utc": end_dt.isoformat().replace("+00:00", "Z"),
                    "probability_percent": value,
                    "units": units,
                    "threshold": "total precipitation >= 1 mm over 24 hours",
                }
            finally:
                eccodes.codes_release(gid)

    ordered = [periods[s] for s in STEPS if s in periods]
    if not ordered:
        raise RuntimeError("GRIB2 downloaded, but no tpg1 messages for requested 24-hour step ranges were found")

    print(json.dumps({
        "provider": "ECMWF AIFS ENS Open Data",
        "model": "aifs-ens",
        "parameter": PARAM,
        "description": "Probability of total precipitation >= 1 mm in each 24-hour forecast period",
        "run_utc": run_time,
        "latitude": lat,
        "longitude": lon,
        "periods": ordered,
        "grib_cache": "HIT" if fresh else "REFRESHED",
        "note": "These are 24-hour period probabilities, not hourly rain probabilities. Period boundaries are UTC.",
    }, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"AIFS probability worker error: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)

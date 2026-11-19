#!/usr/bin/env python3
"""Admin-side ECDS retrieval helper. Never expose this script as a public endpoint."""
import json, os, sys
import cdsapi

def main():
    if not os.environ.get("CDSAPI_URL") or not os.environ.get("CDSAPI_KEY"):
        raise RuntimeError("Set CDSAPI_URL and CDSAPI_KEY in the server environment")
    payload = json.load(sys.stdin)
    dataset = payload["dataset"]
    request = payload["request"]
    target = payload["target"]
    if not isinstance(dataset, str) or not dataset or not isinstance(request, dict):
        raise ValueError("dataset and request are required")
    # Dataset name and request must come from an administrator-controlled workflow.
    client = cdsapi.Client(url=os.environ["CDSAPI_URL"], key=os.environ["CDSAPI_KEY"])
    client.retrieve(dataset, request, target)
    print(json.dumps({"ok": True, "target": target, "dataset": dataset}))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ECDS retrieval error: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)

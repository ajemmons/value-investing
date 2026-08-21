"""
Strava -> Google Sheets training log sync.

Pulls new runs from Strava and fills the matching date row's "Miles" and
"Time (min)" cells in the training log Google Sheet. Runs on the same day
are summed into the existing cell values rather than overwriting them.

One-time setup
---------------
1. Strava API access:
   - Create an API app at https://www.strava.com/settings/api to get a
     client ID and client secret.
   - Authorize it once for your own account and exchange the resulting
     code for tokens (see https://developers.strava.com/docs/authentication/):
       GET  https://www.strava.com/oauth/authorize
            ?client_id=<id>&redirect_uri=http://localhost&response_type=code
            &scope=activity:read_all
       POST https://www.strava.com/oauth/token
            with client_id, client_secret, code, grant_type=authorization_code
     Save the refresh_token from that response.

2. Google Sheets access:
   - Create a GCP service account, enable the Google Sheets API for its
     project, and download the JSON key file.
   - Share the training log spreadsheet with the service account's email
     (Editor access).

3. Copy .env.example to .env in this folder and fill in STRAVA_CLIENT_ID,
   STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN, GOOGLE_SERVICE_ACCOUNT_FILE,
   GOOGLE_SHEET_ID, GOOGLE_SHEET_TAB_NAME.

Usage
-----
    python strava_google_sheets_agent.py [--dry-run]
"""

import argparse
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

import requests
from dateutil import parser as date_parser
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool

load_dotenv()

STRAVA_CLIENT_ID = os.environ.get("STRAVA_CLIENT_ID")
STRAVA_CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET")
STRAVA_REFRESH_TOKEN = os.environ.get("STRAVA_REFRESH_TOKEN")
GOOGLE_SERVICE_ACCOUNT_FILE = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "service_account.json")
GOOGLE_SHEET_ID = os.environ.get("GOOGLE_SHEET_ID")
GOOGLE_SHEET_TAB_NAME = os.environ.get("GOOGLE_SHEET_TAB_NAME", "Training Log")

STATE_FILE = Path(__file__).parent / "state.json"
METERS_PER_MILE = 1609.34


def _load_last_synced_epoch() -> int:
    if not STATE_FILE.exists():
        return 0
    return json.loads(STATE_FILE.read_text()).get("last_synced_epoch", 0)


def _save_last_synced_epoch(epoch: int) -> None:
    STATE_FILE.write_text(json.dumps({"last_synced_epoch": epoch}))


def _get_strava_access_token() -> str:
    resp = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": STRAVA_CLIENT_ID,
            "client_secret": STRAVA_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": STRAVA_REFRESH_TOKEN,
        },
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


@tool
def fetch_new_strava_runs() -> list[dict]:
    """Fetch runs from Strava logged since the last sync."""
    last_synced_epoch = _load_last_synced_epoch()
    after = last_synced_epoch + 1 if last_synced_epoch else 0
    access_token = _get_strava_access_token()
    headers = {"Authorization": f"Bearer {access_token}"}

    runs = []
    page = 1
    while True:
        resp = requests.get(
            "https://www.strava.com/api/v3/athlete/activities",
            headers=headers,
            params={"after": after, "page": page, "per_page": 200},
        )
        resp.raise_for_status()
        activities = resp.json()
        if not activities:
            break

        for activity in activities:
            if activity["type"] != "Run":
                continue
            start = date_parser.isoparse(activity["start_date_local"])
            epoch = int(date_parser.isoparse(activity["start_date"]).timestamp())
            runs.append(
                {
                    "date": start.date(),
                    "miles": activity["distance"] / METERS_PER_MILE,
                    "minutes": activity["moving_time"] / 60,
                    "epoch": epoch,
                }
            )

        if len(activities) < 200:
            break
        page += 1

    return runs


def _col_letter(col_index: int) -> str:
    letter = ""
    col_index += 1
    while col_index > 0:
        col_index, remainder = divmod(col_index - 1, 26)
        letter = chr(65 + remainder) + letter
    return letter


def _looks_like_date(value: str) -> bool:
    if not value:
        return False
    try:
        date_parser.parse(value)
        return True
    except (ValueError, OverflowError):
        return False


def _find_header_column(header_rows: list[list[str]], must_include: str, must_exclude: list[str]) -> int | None:
    num_cols = max((len(row) for row in header_rows), default=0)
    for col in range(num_cols):
        text = " ".join(row[col] for row in header_rows if col < len(row) and row[col]).lower()
        if must_include in text and not any(bad in text for bad in must_exclude):
            return col
    return None


def _cell_to_float(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


@tool
def write_runs_to_sheet(runs: list[dict]) -> str:
    """Write each run's miles/minutes into the matching date row of the training log sheet, summing same-day runs."""
    if not runs:
        return "No new runs to write."

    totals_by_date: dict[date, dict[str, float]] = {}
    for run in runs:
        totals = totals_by_date.setdefault(run["date"], {"miles": 0.0, "minutes": 0.0})
        totals["miles"] += run["miles"]
        totals["minutes"] += run["minutes"]

    credentials = Credentials.from_service_account_file(
        GOOGLE_SERVICE_ACCOUNT_FILE,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    service = build("sheets", "v4", credentials=credentials)
    values_api = service.spreadsheets().values()

    grid = values_api.get(
        spreadsheetId=GOOGLE_SHEET_ID,
        range=f"{GOOGLE_SHEET_TAB_NAME}!A1:Z2000",
    ).execute().get("values", [])

    if len(grid) > 1 and not _looks_like_date(grid[1][0] if grid[1] else ""):
        header_rows, data_start = grid[:2], 2
    else:
        header_rows, data_start = grid[:1], 1

    miles_col = _find_header_column(header_rows, "miles", ["weekly", "rec."])
    time_col = _find_header_column(header_rows, "time", ["weekly"])
    if miles_col is None or time_col is None:
        raise RuntimeError("Could not locate Miles/Time (min) columns in the sheet header.")

    date_to_row = {}
    for offset, row in enumerate(grid[data_start:]):
        if row and _looks_like_date(row[0]):
            date_to_row[date_parser.parse(row[0]).date()] = data_start + offset + 1  # 1-indexed sheet row

    updated, skipped = 0, 0
    for run_date, totals in totals_by_date.items():
        row_number = date_to_row.get(run_date)
        if row_number is None:
            print(f"WARNING: no sheet row found for {run_date}, skipping.")
            skipped += 1
            continue

        row_values = grid[row_number - 1] if row_number - 1 < len(grid) else []
        existing_miles = _cell_to_float(row_values[miles_col]) if miles_col < len(row_values) else 0.0
        existing_minutes = _cell_to_float(row_values[time_col]) if time_col < len(row_values) else 0.0

        values_api.update(
            spreadsheetId=GOOGLE_SHEET_ID,
            range=f"{GOOGLE_SHEET_TAB_NAME}!{_col_letter(miles_col)}{row_number}",
            valueInputOption="RAW",
            body={"values": [[round(existing_miles + totals["miles"], 2)]]},
        ).execute()
        values_api.update(
            spreadsheetId=GOOGLE_SHEET_ID,
            range=f"{GOOGLE_SHEET_TAB_NAME}!{_col_letter(time_col)}{row_number}",
            valueInputOption="RAW",
            body={"values": [[round(existing_minutes + totals["minutes"], 1)]]},
        ).execute()
        updated += 1

    return f"Updated {updated} row(s), skipped {skipped} (no matching date)."


workflow = RunnableLambda(lambda _: fetch_new_strava_runs.invoke({})) | RunnableLambda(
    lambda runs: write_runs_to_sheet.invoke({"runs": runs})
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print new runs without writing to the sheet")
    args = parser.parse_args()

    runs = fetch_new_strava_runs.invoke({})
    if not runs:
        print("No new runs since last sync.")
        return

    if args.dry_run:
        for run in runs:
            print(f"{run['date']}: {run['miles']:.2f} mi, {run['minutes']:.1f} min (dry run, not written)")
        return

    summary = write_runs_to_sheet.invoke({"runs": runs})
    print(summary)
    _save_last_synced_epoch(max(run["epoch"] for run in runs))


if __name__ == "__main__":
    main()

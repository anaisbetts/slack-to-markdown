# slack-to-markdown

Incrementally sync a Slack workspace directly into compact, LLM-friendly daily transcript files (`YYYY-MM-DD.txt`) suitable for RAG indexing — without rebuilding history on every run and without touching monthly summary files (`YYYY-MM.txt` / `.monthly-summaries.json`).

Built on Bun with zero runtime dependencies (`bun:sqlite` for local state + native `fetch` for the Slack Web API).

## Installation

Requires [Bun](https://bun.sh/).

Link the `slack-to-markdown` binary globally (uses the `"bin"` entry in `package.json` pointing to `./src/index.ts` with `#!/usr/bin/env bun`):

```bash
bun install
bun link
slack-to-markdown --help
```

Or run directly from the repo without linking:

```bash
bun run start -- --help
# or
./src/index.ts --help
```

## Quick Start

### 1. Optional: Seed from an existing `slack-archive` backup

If you already have a `slack-archive` JSON data directory (`users.json`, `channels.json`, `[CDG]*.json`), import it locally into SQLite in seconds instead of pulling years of history through Slack's rate limits:

```bash
slack-to-markdown ~/archives/slack-archives \
  --seed-from /path/to/slack-archive/data \
  --excludes "house-debug,dont-talk-in-here,cadwallion (cadwallion)" \
  --render-only
```

Passing `--exclude` / `--excludes` with `--seed-from` automatically saves those exclusions into `<output-dir>/.slack-to-markdown/config.json` for all future runs.

### 2. Sync incrementally from Slack

Provide a Slack user token via `SLACK_TOKEN` or `--token`:

```bash
SLACK_TOKEN=xoxp-... slack-to-markdown ~/archives/slack-archives
```

On the first sync, the token and its authenticated Slack user/workspace identity (`auth.test`) are stored in `<output-dir>/.slack-to-markdown/archive.sqlite` (`0600`). Subsequent runs can omit `SLACK_TOKEN` to reuse the saved token. If a different `SLACK_TOKEN` is supplied later, the tool verifies via `auth.test` that it still belongs to the same Slack user and workspace — rotating the saved token if it matches, or aborting immediately if it belongs to a different account.

### 3. Re-render from SQLite offline

Raw Slack payloads are cached in SQLite, so you can re-render all daily files anytime without calling Slack:

```bash
slack-to-markdown ~/archives/slack-archives --render-only --rerender
```

## How Incremental Sync Works

- **Fast discovery by default**: On normal runs, avoids polling hundreds of dormant/empty DMs by combining:
  - `client.counts` (1 API call returning latest message timestamps across channels, MPIMs, and DMs),
  - `search.messages` (`after:YYYY-MM-DD`, catching activity including replies posted to older threads),
  - channels active within `--active-window-days` (default `30`), and
  - newly discovered channels never synced before.
- **Automatic weekly full scan**: Every `--full-scan-days` (default `7`) — or whenever `--full-scan` is passed, or if both `client.counts` and `search.messages` are unavailable — sweeps all non-archived channels.
- **14-day rolling lookback & thread diffing**: Active channels query `conversations.history` back to `min(last_message_ts, now - lookbackDays)` (default `14` days) and compare `reply_count` / `latest_reply` against SQLite, calling `conversations.replies` only for threads with new or missing replies.
- **Resumable & rate-limit aware**: Respects HTTP `429` `Retry-After` headers, retries transient 5xx/network failures with backoff, commits each channel transactionally, and renders its dirty days immediately so interrupted runs preserve progress.
- **Archived & excluded channels**: Permanently skips archived channels and deleted-user DMs once synced once, and skips excluded channels before making history API calls.

## Output Layout & Format

```text
<output-dir>/
├── .slack-to-markdown/
│   ├── archive.sqlite          # SQLite cache (WAL mode, 0600)
│   └── config.json             # Optional persistent defaults & exclusions
├── general/
│   ├── 2026-11-18.txt          # Managed by slack-to-markdown
│   ├── 2026-11-20.txt          # Managed by slack-to-markdown
│   ├── 2026-11.txt             # Untouched (external monthly summary)
│   └── .monthly-summaries.json # Untouched (external summary manifest)
└── Alice Smith (alice)/
    └── 2026-11-20.txt
```

Channel folder names are pinned per channel ID in SQLite so DM display-name edits or Slack channel renames never create duplicate folders or orphan monthly summaries.

Each `YYYY-MM-DD.txt` file uses UTC timestamps, per-day shortest-unique-prefix speaker abbreviations, 10-minute `HH:MM` buckets, cleaned Slack markup (`<@U...>`, `<#C...>`, links, HTML entities), concise file/attachment summaries, and thread context:

```text
Users:
a - Alice Smith
b - Bob Jones

14:20
a: Did we merge the auth PR yet?
  > b: Just merged it five minutes ago!

15:00
[Thread from 2026-11-18 by Bob Jones: "We should revisit the rate limit settings next week"]
  > a: Bumping this — fast discovery with client.counts + search.messages solved it.
```

Only days whose rendered content actually changes are written to disk; historical days are left untouched when cross-day thread replies arrive.

## Configuration

Optional `<output-dir>/.slack-to-markdown/config.json`:

```json
{
  "exclude": ["house-debug", "dont-talk-in-here", "cadwallion (cadwallion)"],
  "channelTypes": ["public_channel", "private_channel", "mpim", "im"],
  "lookbackDays": 14,
  "activeWindowDays": 30,
  "fullScanIntervalDays": 7
}
```

Exclusions match case-insensitively against channel ID, Slack channel name, or pinned folder name. CLI flags merge with (`exclude`) or override (`channelTypes`, `lookbackDays`, `activeWindowDays`, `fullScanIntervalDays`) values from `config.json`.

## CLI Options

- `<output-dir>` — Target archive directory (required).
- `--token TOKEN` — Slack API token (overrides `SLACK_TOKEN` and saved SQLite token).
- `--seed-from DIR` — Import an existing `slack-archive` JSON data directory into SQLite and render historical day files.
- `--render-only` — Skip Slack API calls; only render dirty (or `--rerender`) days.
- `--rerender` — Mark all stored days dirty and re-render `YYYY-MM-DD.txt` files from SQLite.
- `--full-scan` — Poll every non-archived channel instead of using fast discovery.
- `--exclude, --excludes NAME_OR_ID` — Exclude channels by ID, Slack name, or folder name (repeatable or comma-separated; saved to `config.json` when combined with `--seed-from`).
- `--channel-types LIST` — Comma-separated channel types (default: `public_channel,private_channel,mpim,im`).
- `--lookback-days N` — Rolling history lookback window in days (default: `14`).
- `--active-window-days N` — Always poll channels active within the last `N` days on fast scans (default: `30`).
- `--full-scan-days N` — Interval in days between automatic full scans (default: `7`).
- `--channel NAME_OR_ID` — Limit sync, seed, or render to a single channel.
- `--dry-run` — Preview work without writing files or mutating SQLite.
- `--quiet, -q` — Suppress progress output.
- `--help, -h` — Show help text.

## Development

```bash
bun test       # Run unit and integration tests
bun run check  # Run Biome lint/format check and TypeScript typecheck
bun run f      # Auto-format and fix with Biome
```

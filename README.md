# NordicTax

NordicTax is a FIFO-based crypto tax calculator for BTC mining payouts and BTC card spending.

It outputs the three core values for your yearly filing:

- Total mining income (NOK)
- Total capital gain/loss from card spending (NOK)
- Year-end portfolio value (NOK)

## Features

- FIFO lot matching engine
- Normalized CSV mode (price included per row)
- Raw adapter mode for GoMining and Bybit exports
- Auto-detection of common GoMining and Bybit CSV header variants
- Row filtering for card spends vs deposits/transfers in adapter mode
- Warning surfacing for filtered/unknown Bybit card rows
- CoinGecko BTC/NOK price lookup by transaction timestamp
- CoinGecko local cache at `.cache/coingecko-nok-cache.json`
- Optional JSON report export
- Skatteetaten-friendly export in JSON and CSV
- Optional opening balance lot (FIFO lot #0 at Jan 1)
- Optional per-spend FIFO audit journal CSV export
- Next.js dashboard for CSV upload and one-click calculation
- Unit tests and CI workflow

## CLI Modes

### 1. Normalized CSV mode

Expected columns in both files:

- `id`
- `timestamp` (ISO 8601, example `2026-01-02T08:00:00Z`)
- `amount_btc` (positive BTC amount)
- `nok_price_per_btc` (BTC/NOK at that timestamp)

Sample files:

- `data/mining.csv`
- `data/card_spends.csv`

Run:

```bash
npm run report -- --mining data/mining.csv --spends data/card_spends.csv --tax-year 2026 --year-end-price 950000
```

### 2. Raw adapter mode + CoinGecko

Use this when files only include timestamp + BTC amount.

Sample files:

- `data/gomining_raw.csv`
- `data/bybit_raw.csv`

Run:

```bash
npm run report -- --gomining data/gomining_raw.csv --bybit data/bybit_raw.csv --tax-year 2026 --use-coingecko --out output/report-2026.json
```

If `--year-end-price` is omitted, year-end BTC/NOK is fetched from CoinGecko automatically.

Year-end valuation uses 31 Dec 23:59 Norway time (CET), equivalent to 22:59 UTC.

### 2b. Opening balance (recommended when inventory starts before imported history)

If your BTC inventory existed before imported mining rows, add opening lot inputs:

```bash
npm run report -- --gomining data/gomining_raw.csv --bybit data/bybit_raw.csv --tax-year 2026 --use-coingecko --opening-btc 0.01 --opening-cost-basis 650000
```

This adds FIFO lot #0 at `YYYY-01-01T00:00:00Z` and prevents false insufficient-inventory failures.

### 3. Skatteetaten export files

Generate pre-fill outputs for manual Skatteetaten entry:

```bash
npm run report -- --mining data/mining.csv --spends data/card_spends.csv --tax-year 2026 --year-end-price 950000 --skatteetaten-out output/skatteetaten-2026
```

This writes:

- `output/skatteetaten-2026.json`
- `output/skatteetaten-2026.csv`

### 4. Audit journal export

Generate a transaction-level FIFO trail for review/audit:

```bash
npm run report -- --gomining data/gomining_raw.csv --bybit data/bybit_raw.csv --tax-year 2026 --use-coingecko --audit-out output/audit-journal-2026.csv
```

## Dashboard (Next.js)

Install dashboard dependencies:

```bash
npm run web:install
```

Start dashboard:

```bash
npm run web:dev
```

Shortcut from root:

```bash
npm run dev
```

Open `http://localhost:3000` and upload your CSV files.

## Build and Typecheck

```bash
npm run typecheck
npm run build
npm test
npm run web:build
```

## CI

GitHub Actions workflow is available at `.github/workflows/ci.yml`.
It runs typecheck, build, tests, and dashboard build on push and pull requests.

## Netlify Deployment

This repository is configured for Netlify using `netlify.toml` at the repo root.

Key setup:

- Base directory: `web`
- Build command: `npm run build`
- Runtime plugin: `@netlify/plugin-nextjs`
- Node version: `22`

Recommended deploy steps:

1. Connect the GitHub repository in Netlify.
2. Keep build settings from `netlify.toml` (do not override base/build command manually).
3. Trigger deploy from the default branch.
4. Verify `/` and `/api/report` after deployment.

Operational notes for smooth production runs:

- Dev and build outputs are isolated (`.next-dev` for dev and `.next` for production build) to avoid cache/chunk collisions.
- Avoid running parallel local dev servers in the same workspace.
- CSV uploads are handled by a server route (`/api/report`); very large CSV files may hit serverless body/time limits depending on Netlify plan/runtime.

## Notes

- This project is informational software, not legal/tax advice.
- Always verify results before filing to Skatteetaten.

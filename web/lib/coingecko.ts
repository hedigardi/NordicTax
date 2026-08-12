import { PricedTransaction, RawTransaction } from "./tax";

interface CoinGeckoRangeResponse {
  prices?: Array<[number, number]>;
}

interface CoinGeckoSimplePriceResponse {
  bitcoin?: {
    nok?: number;
  };
}

const cache = new Map<string, number>();

function minuteKey(ts: Date): string {
  return ts.toISOString().slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClosestPrice(
  points: Array<[number, number]>,
  timestampMs: number,
): number {
  const first = points[0];
  if (!first) {
    throw new Error("No CoinGecko points returned");
  }

  let best = first[1];
  let dist = Number.POSITIVE_INFINITY;

  for (const [ms, price] of points) {
    const d = Math.abs(ms - timestampMs);
    if (d < dist) {
      dist = d;
      best = price;
    }
  }

  return best;
}

async function fetchRange(
  fromUnix: number,
  toUnix: number,
): Promise<Array<[number, number]>> {
  const url = new URL(
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range",
  );
  url.searchParams.set("vs_currency", "nok");
  url.searchParams.set("from", String(fromUnix));
  url.searchParams.set("to", String(toUnix));

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.ok) {
      const body = (await response.json()) as CoinGeckoRangeResponse;
      return body.prices ?? [];
    }

    if (response.status !== 429 || attempt === 4) {
      throw new Error(`CoinGecko error ${response.status}`);
    }

    await sleep(600 * attempt);
  }

  throw new Error("CoinGecko request failed");
}

async function fetchNokPriceAt(timestamp: Date): Promise<number> {
  const key = minuteKey(timestamp);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const center = Math.floor(timestamp.getTime() / 1000);
  const prices = await fetchRange(center - 1800, center + 1800);
  if (prices.length === 0) {
    throw new Error(`No price data at ${timestamp.toISOString()}`);
  }

  const best = getClosestPrice(prices, timestamp.getTime());

  cache.set(key, best);
  return best;
}

export async function enrichWithCoinGecko(
  raw: RawTransaction[],
): Promise<PricedTransaction[]> {
  if (raw.length === 0) {
    return [];
  }

  const timestamps = raw.map((tx) => tx.timestamp.getTime());
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const points = await fetchRange(
    Math.floor(minTs / 1000) - 1800,
    Math.floor(maxTs / 1000) + 1800,
  );

  if (points.length === 0) {
    throw new Error("No CoinGecko price data in selected time range");
  }

  const output: PricedTransaction[] = [];

  for (const tx of raw) {
    const key = minuteKey(tx.timestamp);
    const price =
      cache.get(key) ?? getClosestPrice(points, tx.timestamp.getTime());
    cache.set(key, price);

    output.push({ ...tx, nokPricePerBtc: price });
  }

  return output;
}

export async function getYearEndPriceFromCoinGecko(
  taxYear: number,
): Promise<number> {
  const ts = new Date(Date.UTC(taxYear, 11, 31, 22, 59, 59, 999));

  if (ts.getTime() > Date.now()) {
    throw new Error(
      "Year-end price is not available yet for a future tax year.",
    );
  }

  return fetchNokPriceAt(ts);
}

export async function getLatestNokPriceFromCoinGecko(): Promise<number> {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=nok";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.ok) {
      const body = (await response.json()) as CoinGeckoSimplePriceResponse;
      const price = body.bitcoin?.nok;
      if (!price || !Number.isFinite(price) || price <= 0) {
        throw new Error("CoinGecko latest NOK price response is invalid");
      }
      return price;
    }

    if (response.status !== 429 || attempt === 4) {
      throw new Error(`CoinGecko error ${response.status}`);
    }

    await sleep(600 * attempt);
  }

  throw new Error("CoinGecko request failed");
}

import fs from "node:fs";
import path from "node:path";
import { CryptoTransaction, RawCryptoTransaction } from "./types.js";

interface CoinGeckoRangeResponse {
  prices?: Array<[number, number]>;
}

interface CacheFileShape {
  [minuteIso: string]: number;
}

function minuteKey(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 16);
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
    throw new Error("No CoinGecko price points available");
  }

  let bestPrice = first[1];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [ms, price] of points) {
    const distance = Math.abs(ms - timestampMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPrice = price;
    }
  }

  return bestPrice;
}

export class CoinGeckoPriceService {
  private readonly cache = new Map<string, number>();
  private readonly cachePath: string;

  public constructor(cachePath = ".cache/coingecko-nok-cache.json") {
    this.cachePath = path.resolve(cachePath);
    this.loadCacheFromDisk();
  }

  public async getNokPricePerBtcAt(timestamp: Date): Promise<number> {
    const key = minuteKey(timestamp);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const center = Math.floor(timestamp.getTime() / 1000);
    const prices = await this.fetchRangePrices(center - 1800, center + 1800);

    if (prices.length === 0) {
      throw new Error(`No CoinGecko price data for ${timestamp.toISOString()}`);
    }

    const bestPrice = getClosestPrice(prices, timestamp.getTime());

    this.cache.set(key, bestPrice);
    this.persistCacheToDisk();

    await sleep(80);
    return bestPrice;
  }

  public async enrichTransactionsWithNokPrices(
    transactions: RawCryptoTransaction[],
  ): Promise<CryptoTransaction[]> {
    if (transactions.length === 0) {
      return [];
    }

    const timestamps = transactions.map((tx) => tx.timestamp.getTime());
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const prices = await this.fetchRangePrices(
      Math.floor(minTs / 1000) - 1800,
      Math.floor(maxTs / 1000) + 1800,
    );

    if (prices.length === 0) {
      throw new Error("No CoinGecko price data for selected transaction range");
    }

    const result: CryptoTransaction[] = [];

    for (const tx of transactions) {
      const key = minuteKey(tx.timestamp);
      const nokPricePerBtc =
        this.cache.get(key) ?? getClosestPrice(prices, tx.timestamp.getTime());
      this.cache.set(key, nokPricePerBtc);

      result.push({
        ...tx,
        nokPricePerBtc,
      });
    }

    this.persistCacheToDisk();

    return result;
  }

  public async getYearEndPriceNokPerBtc(taxYear: number): Promise<number> {
    const yearEnd = new Date(Date.UTC(taxYear, 11, 31, 22, 59, 59, 999));

    if (yearEnd.getTime() > Date.now()) {
      throw new Error(
        `Cannot auto-fetch year-end price for ${taxYear} before year-end has passed. Provide --year-end-price manually.`,
      );
    }

    return this.getNokPricePerBtcAt(yearEnd);
  }

  private async fetchRangePrices(
    fromUnix: number,
    toUnix: number,
  ): Promise<Array<[number, number]>> {
    const url = new URL(
      "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range",
    );
    url.searchParams.set("vs_currency", "nok");
    url.searchParams.set("from", String(fromUnix));
    url.searchParams.set("to", String(toUnix));

    let lastError: string | null = null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });

      if (response.ok) {
        const body = (await response.json()) as CoinGeckoRangeResponse;
        return body.prices ?? [];
      }

      lastError = `CoinGecko request failed (${response.status})`;

      if (response.status !== 429 || attempt === 4) {
        break;
      }

      await sleep(600 * attempt);
    }

    throw new Error(lastError ?? "CoinGecko request failed");
  }

  private loadCacheFromDisk(): void {
    if (!fs.existsSync(this.cachePath)) {
      return;
    }

    const text = fs.readFileSync(this.cachePath, "utf8");
    const parsed = JSON.parse(text) as CacheFileShape;

    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        this.cache.set(k, v);
      }
    }
  }

  private persistCacheToDisk(): void {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const out: CacheFileShape = {};

    for (const [k, v] of this.cache.entries()) {
      out[k] = v;
    }

    fs.writeFileSync(this.cachePath, JSON.stringify(out, null, 2), "utf8");
  }
}

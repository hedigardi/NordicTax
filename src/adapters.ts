import fs from "node:fs";
import Papa from "papaparse";
import {
  RawCryptoTransaction,
  SATOSHIS_PER_BTC,
  TransactionType,
} from "./types.js";

interface RawCsvRow {
  [key: string]: string | undefined;
}

interface AdapterConfig {
  idFields: string[];
  timestampFields: string[];
  amountFields: string[];
  signFields?: string[];
  hintFields?: string[];
  includeHintWords?: string[];
  excludeHintWords?: string[];
  shouldIncludeRow?: (row: RawCsvRow) => boolean;
}

export interface AdapterParseResult {
  transactions: RawCryptoTransaction[];
  warnings: string[];
}

function btcToSats(btc: number): bigint {
  return BigInt(Math.round(btc * Number(SATOSHIS_PER_BTC)));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCell(value: string): string {
  return value.trim().toLowerCase();
}

function parseDecimalValue(raw: string): number {
  const cleaned = raw
    .trim()
    .replace(/\s/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9eE.+-]/g, "");

  return Number(cleaned);
}

function parseTimestamp(raw: string): Date {
  const trimmed = raw.trim();
  const bybitUtcNoOffset = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const normalized = bybitUtcNoOffset.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;

  return new Date(normalized);
}

function pickField(row: RawCsvRow, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = row[field];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function buildRowHint(row: RawCsvRow, fields: string[] | undefined): string {
  if (!fields || fields.length === 0) {
    return "";
  }

  return fields
    .map((field) => row[field])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map(normalizeCell)
    .join(" ");
}

function hasAnyWord(haystack: string, words: string[] | undefined): boolean {
  if (!words || words.length === 0) {
    return false;
  }

  return words.some((word) => haystack.includes(word));
}

function parseRawCsvText(
  csvText: string,
  type: TransactionType,
  config: AdapterConfig,
  sourceName: string,
  warnings: string[] = [],
): RawCryptoTransaction[] {
  const preparedCsv = csvText.trimStart().startsWith("UID:")
    ? csvText.split(/\r?\n/).slice(1).join("\n")
    : csvText;

  const parsed = Papa.parse<RawCsvRow>(preparedCsv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  });

  if (parsed.errors.length > 0) {
    const err = parsed.errors[0];
    throw new Error(
      `CSV parse error in ${sourceName}: ${err?.message ?? "unknown"} at row ${err?.row ?? "unknown"}`,
    );
  }

  const rows: RawCryptoTransaction[] = [];

  parsed.data.forEach((row, index) => {
    const rowNumber = index + 2;

    if (config.shouldIncludeRow && !config.shouldIncludeRow(row)) {
      return;
    }

    const rowHint = buildRowHint(row, config.hintFields);
    if (
      config.includeHintWords &&
      config.includeHintWords.length > 0 &&
      rowHint.length > 0 &&
      !hasAnyWord(rowHint, config.includeHintWords)
    ) {
      return;
    }

    if (hasAnyWord(rowHint, config.excludeHintWords)) {
      return;
    }

    const id =
      pickField(row, config.idFields) ??
      `${type.toLowerCase()}_${rows.length + 1}`;
    const timestampRaw = pickField(row, config.timestampFields);
    const amountRaw = pickField(row, config.amountFields);
    const signRaw = config.signFields
      ? pickField(row, config.signFields)
      : undefined;

    if (!timestampRaw) {
      throw new Error(
        `Missing timestamp field in ${sourceName} at row ${rowNumber}`,
      );
    }

    if (!amountRaw) {
      throw new Error(
        `Missing amount field in ${sourceName} at row ${rowNumber}`,
      );
    }

    const timestamp = parseTimestamp(timestampRaw);
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error(
        `Invalid timestamp in ${sourceName} at row ${rowNumber}: ${timestampRaw}`,
      );
    }

    const amountBtc = parseDecimalValue(amountRaw);
    if (!Number.isFinite(amountBtc) || amountBtc === 0) {
      throw new Error(
        `Invalid BTC amount in ${sourceName} at row ${rowNumber}: ${amountRaw}`,
      );
    }

    const effectiveAmountBtc =
      signRaw && parseDecimalValue(signRaw) !== 0
        ? Math.abs(amountBtc) * Math.sign(parseDecimalValue(signRaw))
        : amountBtc;

    if (effectiveAmountBtc < 0 && type === "MINING_PAYOUT") {
      return;
    }

    if (effectiveAmountBtc > 0 && type === "CARD_SPEND") {
      warnings.push(
        `Ignored positive BTC card row in ${sourceName} at row ${rowNumber}; expected net outflow (QTY < 0).`,
      );
      return;
    }

    rows.push({
      id: id.trim(),
      timestamp,
      type,
      amountSats: btcToSats(Math.abs(effectiveAmountBtc)),
    });
  });

  return rows;
}

function collectBybitSaleTimestamps(csvText: string): Set<string> {
  const preparedCsv = csvText.trimStart().startsWith("UID:")
    ? csvText.split(/\r?\n/).slice(1).join("\n")
    : csvText;

  const parsed = Papa.parse<RawCsvRow>(preparedCsv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  });

  const result = new Set<string>();

  for (const row of parsed.data) {
    const coin = normalizeCell(row.coin ?? "");
    const typeValue = normalizeCell(row.type ?? "");
    const description = normalizeCell(row.description ?? "");
    const timestamp = pickField(row, [
      "timestamp",
      "time",
      "date",
      "created_at",
      "datetime",
      "date & time(utc)",
    ]);

    if (
      coin === "btc" &&
      typeValue === "bybit card" &&
      description.includes("sale") &&
      timestamp
    ) {
      result.add(timestamp.trim());
    }
  }

  return result;
}

export function loadGoMiningPayoutsFromCsv(
  filePath: string,
): RawCryptoTransaction[] {
  const text = fs.readFileSync(filePath, "utf8");
  return parseRawCsvText(
    text,
    "MINING_PAYOUT",
    {
      idFields: ["id", "txid", "tx_id", "transaction_id"],
      timestampFields: [
        "timestamp",
        "time",
        "date",
        "created_at",
        "datetime",
        "date & time(utc)",
      ],
      amountFields: [
        "income",
        "amount_btc",
        "btc_amount",
        "amount",
        "btc",
        "reward_btc",
      ],
      hintFields: ["type", "event", "description", "note", "operation"],
      includeHintWords: ["mining", "reward", "payout", "daily"],
      excludeHintWords: ["fee", "withdraw", "deposit", "transfer"],
      shouldIncludeRow: (row) => {
        const status = normalizeCell(row.status ?? "");
        return !status || status === "exported";
      },
    },
    filePath,
  );
}

export function loadBybitCardSpendsFromCsv(
  filePath: string,
): RawCryptoTransaction[] {
  return loadBybitCardSpendsFromCsvWithWarnings(filePath).transactions;
}

export function loadBybitCardSpendsFromCsvWithWarnings(
  filePath: string,
): AdapterParseResult {
  const text = fs.readFileSync(filePath, "utf8");
  const saleTimestamps = collectBybitSaleTimestamps(text);
  const warnings: string[] = [];

  const transactions = parseRawCsvText(
    text,
    "CARD_SPEND",
    {
      idFields: [
        "id",
        "txid",
        "tx_id",
        "orderid",
        "order_id",
        "transaction_id",
      ],
      timestampFields: [
        "timestamp",
        "time",
        "date",
        "created_at",
        "datetime",
        "date & time(utc)",
      ],
      amountFields: [
        "amount_btc",
        "btc_amount",
        "spend_btc",
        "qty",
        "amount",
        "btc",
        "change",
      ],
      hintFields: [
        "type",
        "event",
        "description",
        "note",
        "operation",
        "category",
      ],
      includeHintWords: [
        "card",
        "spend",
        "purchase",
        "payment",
        "debit",
        "pos",
      ],
      excludeHintWords: [
        "deposit",
        "transfer",
        "staking",
        "reward",
        "interest",
      ],
      shouldIncludeRow: (row) => {
        const coin = normalizeCell(row.coin ?? "");
        const typeValue = normalizeCell(row.type ?? "");
        const description = normalizeCell(row.description ?? "");
        const timestampRaw = pickField(row, [
          "timestamp",
          "time",
          "date",
          "created_at",
          "datetime",
          "date & time(utc)",
        ]);

        if (coin && coin !== "btc") {
          return false;
        }

        if (typeValue && typeValue !== "bybit card") {
          return false;
        }

        if (
          description &&
          !(description.includes("purchase") || description.includes("sale"))
        ) {
          warnings.push(
            `Ignored Bybit card row with unsupported description: "${description}". Review this event manually.`,
          );
          return false;
        }

        if (
          description.includes("purchase") &&
          timestampRaw &&
          saleTimestamps.has(timestampRaw.trim())
        ) {
          warnings.push(
            `Deduped Bybit purchase row at ${timestampRaw.trim()} because a matching sale row exists at the same timestamp.`,
          );
          return false;
        }

        const amountRaw = pickField(row, [
          "amount_btc",
          "btc_amount",
          "spend_btc",
          "qty",
          "amount",
          "btc",
          "change",
        ]);
        if (amountRaw && description.includes("purchase")) {
          const amount = parseDecimalValue(amountRaw);
          if (Number.isFinite(amount) && Math.abs(amount) <= 0.0000001) {
            warnings.push(
              `Ignored dust-level Bybit purchase row at ${timestampRaw?.trim() ?? "unknown time"}.`,
            );
            return false;
          }
        }

        return true;
      },
    },
    filePath,
    warnings,
  );

  return {
    transactions,
    warnings,
  };
}

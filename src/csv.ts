import fs from "node:fs";
import Papa from "papaparse";
import {
  CryptoTransaction,
  CsvTransactionRow,
  SATOSHIS_PER_BTC,
  TransactionType,
} from "./types.js";

function parseNumber(
  value: string,
  fieldName: string,
  rowIndex: number,
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName} at row ${rowIndex + 2}: ${value}`);
  }

  return parsed;
}

function btcToSats(btc: number): bigint {
  return BigInt(Math.round(btc * Number(SATOSHIS_PER_BTC)));
}

export function loadTransactionsFromCsv(
  filePath: string,
  type: TransactionType,
): CryptoTransaction[] {
  const csvText = fs.readFileSync(filePath, "utf8");

  const parsed = Papa.parse<CsvTransactionRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  if (parsed.errors.length > 0) {
    const firstError = parsed.errors[0];

    if (!firstError) {
      throw new Error(`CSV parse error in ${filePath}`);
    }

    throw new Error(
      `CSV parse error in ${filePath}: ${firstError.message} (row ${firstError.row ?? "unknown"})`,
    );
  }

  return parsed.data.map((row, idx) => {
    if (!row.timestamp || !row.amount_btc || !row.nok_price_per_btc) {
      throw new Error(
        `Missing required columns in ${filePath} at row ${idx + 2}. Required: timestamp, amount_btc, nok_price_per_btc`,
      );
    }

    const timestamp = new Date(row.timestamp);

    if (Number.isNaN(timestamp.getTime())) {
      throw new Error(
        `Invalid timestamp in ${filePath} at row ${idx + 2}: ${row.timestamp}`,
      );
    }

    const amountBtc = parseNumber(row.amount_btc, "amount_btc", idx);
    const nokPricePerBtc = parseNumber(
      row.nok_price_per_btc,
      "nok_price_per_btc",
      idx,
    );

    if (amountBtc <= 0) {
      throw new Error(
        `amount_btc must be > 0 in ${filePath} at row ${idx + 2}`,
      );
    }

    if (nokPricePerBtc <= 0) {
      throw new Error(
        `nok_price_per_btc must be > 0 in ${filePath} at row ${idx + 2}`,
      );
    }

    return {
      id: row.id?.trim() || `${type.toLowerCase()}_${idx + 1}`,
      timestamp,
      type,
      amountSats: btcToSats(amountBtc),
      nokPricePerBtc,
    };
  });
}

export type TransactionType = "MINING_PAYOUT" | "CARD_SPEND";

import Papa from "papaparse";

const SATS_PER_BTC = 100_000_000n;

export interface RawTransaction {
  id: string;
  timestamp: Date;
  type: TransactionType;
  amountSats: bigint;
}

export interface PricedTransaction extends RawTransaction {
  nokPricePerBtc: number;
}

interface MiningLot {
  id: string;
  timestamp: Date;
  remainingSats: bigint;
  costBasisNokPerBtc: number;
}

export interface TaxSummary {
  taxYear: number;
  miningIncomeNok: number;
  capitalGainLossNok: number;
  yearEndPortfolioValueNok: number;
  remainingBtc: number;
}

export interface OpeningBalanceInput {
  amountSats: bigint;
  costBasisNokPerBtc: number;
}

export interface AuditLotConsumption {
  lotId: string;
  lotTimestamp: Date;
  consumedSats: bigint;
  consumedBtc: number;
  lotCostBasisNokPerBtc: number;
  costBasisNok: number;
}

export interface AuditJournalEntry {
  transactionId: string;
  timestamp: Date;
  spentSats: bigint;
  spentBtc: number;
  salePriceNokPerBtc: number;
  saleValueNok: number;
  costBasisNok: number;
  gainLossNok: number;
  consumedLots: AuditLotConsumption[];
}

export interface TaxComputationResult {
  summary: TaxSummary;
  auditJournal: AuditJournalEntry[];
}

interface CsvRow {
  [key: string]: string | undefined;
}

export interface ParseCsvResult<T extends RawTransaction | PricedTransaction> {
  transactions: T[];
  warnings: string[];
}

function toBtc(sats: bigint): number {
  return Number(sats) / Number(SATS_PER_BTC);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
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

function pickField(row: CsvRow, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function buildHint(row: CsvRow): string {
  return ["type", "event", "description", "note", "operation", "category"]
    .map((key) => row[key])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map(normalizeCell)
    .join(" ");
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function isBybitCardBtcRow(row: CsvRow): boolean {
  const coin = normalizeCell(row.coin ?? "");
  const typeValue = normalizeCell(row.type ?? "");
  return coin === "btc" && typeValue === "bybit card";
}

function getNorwayTaxYearEndUtc(taxYear: number): Date {
  return new Date(Date.UTC(taxYear, 11, 31, 22, 59, 59, 999));
}

export function parseCsvTextWithWarnings(
  csvText: string,
  type: TransactionType,
  mode: "normalized" | "raw",
): ParseCsvResult<RawTransaction | PricedTransaction> {
  const warnings: string[] = [];

  const preparedCsv = csvText.trimStart().startsWith("UID:")
    ? csvText.split(/\r?\n/).slice(1).join("\n")
    : csvText;

  const parsed = Papa.parse<CsvRow>(preparedCsv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(
      `CSV parse error: ${first?.message ?? "unknown"} at row ${first?.row ?? "unknown"}`,
    );
  }

  if (parsed.data.length === 0) {
    return { transactions: [], warnings };
  }

  const bybitSaleTimestamps = new Set<string>();
  if (type === "CARD_SPEND") {
    for (const row of parsed.data) {
      const tsRaw = pickField(row, [
        "timestamp",
        "time",
        "date",
        "created_at",
        "datetime",
        "date & time(utc)",
      ]);
      const description = normalizeCell(row.description ?? "");
      if (tsRaw && isBybitCardBtcRow(row) && description.includes("sale")) {
        bybitSaleTimestamps.add(tsRaw.trim());
      }
    }
  }

  const output: Array<RawTransaction | PricedTransaction> = [];

  for (let i = 0; i < parsed.data.length; i += 1) {
    const row = parsed.data[i] ?? {};
    const rowNumber = i + 2;
    const id =
      pickField(row, [
        "id",
        "txid",
        "tx_id",
        "transaction_id",
        "order_id",
        "orderid",
      ]) ?? `${type.toLowerCase()}_${output.length + 1}`;
    const tsRaw = pickField(row, [
      "timestamp",
      "time",
      "date",
      "created_at",
      "datetime",
      "date & time(utc)",
    ]);
    const btcRaw = pickField(row, [
      "income",
      "amount_btc",
      "btc_amount",
      "amount",
      "btc",
      "spend_btc",
      "qty",
      "change",
    ]);

    if (!tsRaw || !btcRaw) {
      continue;
    }

    const hint = buildHint(row);
    const description = normalizeCell(row.description ?? "");

    if (type === "CARD_SPEND") {
      if (!isBybitCardBtcRow(row)) {
        continue;
      }

      if (
        description &&
        !(description.includes("purchase") || description.includes("sale"))
      ) {
        warnings.push(
          `Ignored Bybit card row ${id} at row ${rowNumber} with unsupported description: "${description}".`,
        );
        continue;
      }

      if (
        description.includes("purchase") &&
        bybitSaleTimestamps.has(tsRaw.trim())
      ) {
        warnings.push(
          `Deduped Bybit purchase row ${id} at ${tsRaw.trim()} because a matching sale row exists.`,
        );
        continue;
      }
    }

    if (
      type === "MINING_PAYOUT" &&
      hint &&
      hasAny(hint, ["fee", "withdraw", "deposit", "transfer"])
    ) {
      continue;
    }

    if (
      type === "CARD_SPEND" &&
      hint &&
      hasAny(hint, ["deposit", "transfer", "staking", "reward", "interest"])
    ) {
      continue;
    }

    const ts = parseTimestamp(tsRaw);
    if (Number.isNaN(ts.getTime())) {
      throw new Error(`Invalid timestamp at data row ${rowNumber}: ${tsRaw}`);
    }

    const btc = parseDecimalValue(btcRaw);
    if (!Number.isFinite(btc) || btc === 0) {
      throw new Error(`Invalid amount_btc at data row ${rowNumber}: ${btcRaw}`);
    }

    if (
      type === "CARD_SPEND" &&
      description.includes("purchase") &&
      Math.abs(btc) <= 0.0000001
    ) {
      warnings.push(
        `Ignored dust-level Bybit purchase row ${id} at row ${rowNumber}.`,
      );
      continue;
    }

    if (type === "MINING_PAYOUT" && btc < 0) {
      continue;
    }

    if (type === "CARD_SPEND" && mode === "raw" && btc > 0) {
      warnings.push(
        `Ignored positive BTC Bybit card row ${id} at row ${rowNumber}; expected net outflow (QTY < 0).`,
      );
      continue;
    }

    const base: RawTransaction = {
      id,
      timestamp: ts,
      type,
      amountSats: BigInt(Math.round(Math.abs(btc) * Number(SATS_PER_BTC))),
    };

    if (mode === "raw") {
      output.push(base);
      continue;
    }

    const priceRaw = pickField(row, ["nok_price_per_btc"]);
    if (!priceRaw) {
      throw new Error("Normalized mode requires nok_price_per_btc column.");
    }

    const price = parseDecimalValue(priceRaw);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `Invalid nok_price_per_btc at data row ${rowNumber}: ${priceRaw}`,
      );
    }

    output.push({
      ...base,
      nokPricePerBtc: price,
    });
  }

  return {
    transactions: output as RawTransaction[] | PricedTransaction[],
    warnings,
  };
}

export function parseCsvText(
  csvText: string,
  type: TransactionType,
  mode: "normalized" | "raw",
): RawTransaction[] | PricedTransaction[] {
  return parseCsvTextWithWarnings(csvText, type, mode).transactions;
}

export function runFifoTax(
  transactions: PricedTransaction[],
  taxYear: number,
  yearEndPriceNokPerBtc: number,
  options?: {
    openingBalance?: OpeningBalanceInput;
  },
): TaxComputationResult {
  const fifo: MiningLot[] = [];

  if (options?.openingBalance) {
    fifo.push({
      id: "opening_balance_lot",
      timestamp: new Date(Date.UTC(taxYear, 0, 1, 0, 0, 0, 0)),
      remainingSats: options.openingBalance.amountSats,
      costBasisNokPerBtc: options.openingBalance.costBasisNokPerBtc,
    });
  }

  const sorted = [...transactions].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const yearEnd = getNorwayTaxYearEndUtc(taxYear);

  let miningIncomeNok = 0;
  let capitalGainLossNok = 0;
  const auditJournal: AuditJournalEntry[] = [];

  for (const tx of sorted) {
    if (tx.timestamp > yearEnd) {
      break;
    }

    if (tx.type === "MINING_PAYOUT") {
      miningIncomeNok += toBtc(tx.amountSats) * tx.nokPricePerBtc;
      fifo.push({
        id: tx.id,
        timestamp: tx.timestamp,
        remainingSats: tx.amountSats,
        costBasisNokPerBtc: tx.nokPricePerBtc,
      });
      continue;
    }

    let satsToSell = tx.amountSats;
    const saleValue = toBtc(tx.amountSats) * tx.nokPricePerBtc;
    let costBasis = 0;
    const consumedLots: AuditLotConsumption[] = [];

    while (satsToSell > 0n && fifo.length > 0) {
      const lot = fifo[0];
      if (!lot) {
        break;
      }

      if (lot.remainingSats <= satsToSell) {
        const consumedSats = lot.remainingSats;
        satsToSell -= consumedSats;
        const consumedCost = toBtc(consumedSats) * lot.costBasisNokPerBtc;
        costBasis += consumedCost;
        consumedLots.push({
          lotId: lot.id,
          lotTimestamp: lot.timestamp,
          consumedSats,
          consumedBtc: toBtc(consumedSats),
          lotCostBasisNokPerBtc: lot.costBasisNokPerBtc,
          costBasisNok: round2(consumedCost),
        });
        fifo.shift();
      } else {
        const consumedSats = satsToSell;
        const consumedCost = toBtc(consumedSats) * lot.costBasisNokPerBtc;
        costBasis += consumedCost;
        consumedLots.push({
          lotId: lot.id,
          lotTimestamp: lot.timestamp,
          consumedSats,
          consumedBtc: toBtc(consumedSats),
          lotCostBasisNokPerBtc: lot.costBasisNokPerBtc,
          costBasisNok: round2(consumedCost),
        });
        lot.remainingSats -= consumedSats;
        satsToSell = 0n;
      }
    }

    if (satsToSell > 0n) {
      throw new Error(`Insufficient BTC inventory for transaction ${tx.id}`);
    }

    const gainLoss = saleValue - costBasis;
    capitalGainLossNok += gainLoss;

    if (tx.timestamp.getUTCFullYear() === taxYear) {
      auditJournal.push({
        transactionId: tx.id,
        timestamp: tx.timestamp,
        spentSats: tx.amountSats,
        spentBtc: toBtc(tx.amountSats),
        salePriceNokPerBtc: tx.nokPricePerBtc,
        saleValueNok: round2(saleValue),
        costBasisNok: round2(costBasis),
        gainLossNok: round2(gainLoss),
        consumedLots,
      });
    }
  }

  const remainingSats = fifo.reduce((sum, lot) => sum + lot.remainingSats, 0n);
  const remainingBtc = toBtc(remainingSats);

  return {
    summary: {
      taxYear,
      miningIncomeNok: round2(miningIncomeNok),
      capitalGainLossNok: round2(capitalGainLossNok),
      yearEndPortfolioValueNok: round2(remainingBtc * yearEndPriceNokPerBtc),
      remainingBtc,
    },
    auditJournal,
  };
}

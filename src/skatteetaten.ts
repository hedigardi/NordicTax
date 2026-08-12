import fs from "node:fs";
import path from "node:path";
import { TaxSummary } from "./types.js";

export interface SkatteetatenExportInput {
  summary: TaxSummary;
  pricingSource: "csv" | "coingecko";
  generatedAtUtc: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toCsvValue(value: string | number): string {
  if (typeof value === "number") {
    return String(value);
  }

  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

function buildCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0] ?? {});
  const lines = [headers.join(",")];

  for (const row of rows) {
    const line = headers
      .map((header) => toCsvValue(row[header] ?? ""))
      .join(",");
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

export function createSkatteetatenPayload(
  input: SkatteetatenExportInput,
): Record<string, unknown> {
  return {
    generatedAtUtc: input.generatedAtUtc,
    taxYear: input.summary.taxYear,
    source: "NordicTax",
    pricingSource: input.pricingSource,
    sections: {
      kapitalinntekt: {
        miningIncomeNok: round2(input.summary.totalMiningIncomeNok),
      },
      realisasjon: {
        capitalGainLossNok: round2(input.summary.totalCapitalGainLossNok),
      },
      formue31desember: {
        yearEndPortfolioValueNok: round2(
          input.summary.yearEndPortfolioValueNok,
        ),
        remainingBtc: Number(input.summary.remainingBtc.toFixed(8)),
      },
    },
    transactionCounts: {
      miningTransactionsInYear: input.summary.processedMiningTransactions,
      spendTransactionsInYear: input.summary.processedSpendTransactions,
    },
    disclaimer:
      "Pre-fill export for manual Skatteetaten entry. Validate all values before filing.",
  };
}

export function writeSkatteetatenExport(
  basePath: string,
  input: SkatteetatenExportInput,
): { jsonPath: string; csvPath: string } {
  const resolved = path.resolve(basePath);
  const ext = path.extname(resolved).toLowerCase();
  const prefix =
    ext === ".json" || ext === ".csv"
      ? resolved.slice(0, -ext.length)
      : resolved;

  const payload = createSkatteetatenPayload(input);
  const jsonPath = `${prefix}.json`;
  const csvPath = `${prefix}.csv`;

  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const csvRows = [
    {
      tax_year: input.summary.taxYear,
      field: "mining_income_nok",
      value: round2(input.summary.totalMiningIncomeNok),
      category: "kapitalinntekt",
    },
    {
      tax_year: input.summary.taxYear,
      field: "capital_gain_loss_nok",
      value: round2(input.summary.totalCapitalGainLossNok),
      category: "realisasjon",
    },
    {
      tax_year: input.summary.taxYear,
      field: "year_end_portfolio_value_nok",
      value: round2(input.summary.yearEndPortfolioValueNok),
      category: "formue_31_12",
    },
    {
      tax_year: input.summary.taxYear,
      field: "remaining_btc_31_12",
      value: Number(input.summary.remainingBtc.toFixed(8)),
      category: "formue_31_12",
    },
  ];

  fs.writeFileSync(csvPath, buildCsv(csvRows), "utf8");
  return { jsonPath, csvPath };
}

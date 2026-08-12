import fs from "node:fs";
import path from "node:path";
import {
  loadBybitCardSpendsFromCsvWithWarnings,
  loadGoMiningPayoutsFromCsv,
} from "./adapters.js";
import { loadTransactionsFromCsv } from "./csv.js";
import { NordicTaxEngine } from "./engine.js";
import { CoinGeckoPriceService } from "./pricing.js";
import { writeSkatteetatenExport } from "./skatteetaten.js";
import { CryptoTransaction } from "./types.js";

interface CliOptions {
  miningFile: string;
  spendsFile: string;
  goMiningFile?: string;
  bybitFile?: string;
  taxYear: number;
  yearEndPriceNokPerBtc?: number;
  useCoinGecko: boolean;
  outFile?: string;
  skatteetatenOut?: string;
  auditOut?: string;
  openingBtc?: number;
  openingCostBasisNokPerBtc?: number;
}

interface ResolvedTransactions {
  transactions: CryptoTransaction[];
  warnings: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];

  if (args[0] === "report") {
    args.shift();
  }

  const readArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index === -1) {
      return undefined;
    }

    return args[index + 1];
  };

  const miningFile = readArg("--mining") ?? "data/mining.csv";
  const spendsFile = readArg("--spends") ?? "data/card_spends.csv";
  const goMiningFile = readArg("--gomining");
  const bybitFile = readArg("--bybit");
  const taxYearRaw =
    readArg("--tax-year") ?? new Date().getUTCFullYear().toString();
  const yearEndPriceRaw = readArg("--year-end-price");
  const useCoinGecko = args.includes("--use-coingecko");
  const outFile = readArg("--out");
  const skatteetatenOut = readArg("--skatteetaten-out");
  const auditOut = readArg("--audit-out");
  const openingBtcRaw = readArg("--opening-btc");
  const openingCostBasisRaw = readArg("--opening-cost-basis");

  const taxYear = Number(taxYearRaw);
  const yearEndPriceNokPerBtc =
    yearEndPriceRaw !== undefined ? Number(yearEndPriceRaw) : undefined;
  const openingBtc =
    openingBtcRaw !== undefined ? Number(openingBtcRaw) : undefined;
  const openingCostBasisNokPerBtc =
    openingCostBasisRaw !== undefined ? Number(openingCostBasisRaw) : undefined;

  if (!Number.isInteger(taxYear) || taxYear < 2009) {
    throw new Error(`Invalid --tax-year value: ${taxYearRaw}`);
  }

  if (
    yearEndPriceNokPerBtc !== undefined &&
    (!Number.isFinite(yearEndPriceNokPerBtc) || yearEndPriceNokPerBtc <= 0)
  ) {
    throw new Error(`Invalid --year-end-price value: ${yearEndPriceRaw}`);
  }

  const hasOpeningBtc = openingBtc !== undefined;
  const hasOpeningCost = openingCostBasisNokPerBtc !== undefined;
  if (hasOpeningBtc !== hasOpeningCost) {
    throw new Error(
      "Opening balance requires both --opening-btc and --opening-cost-basis.",
    );
  }

  if (
    openingBtc !== undefined &&
    (!Number.isFinite(openingBtc) || openingBtc <= 0)
  ) {
    throw new Error(`Invalid --opening-btc value: ${openingBtcRaw}`);
  }

  if (
    openingCostBasisNokPerBtc !== undefined &&
    (!Number.isFinite(openingCostBasisNokPerBtc) ||
      openingCostBasisNokPerBtc <= 0)
  ) {
    throw new Error(
      `Invalid --opening-cost-basis value: ${openingCostBasisRaw}`,
    );
  }

  const usingRawAdapters = Boolean(goMiningFile || bybitFile);
  if (usingRawAdapters && (!goMiningFile || !bybitFile)) {
    throw new Error(
      "When using adapters you must pass both --gomining and --bybit CSV files.",
    );
  }

  if (usingRawAdapters && !useCoinGecko) {
    throw new Error(
      "Adapter mode requires --use-coingecko to resolve NOK price per transaction timestamp.",
    );
  }

  if (
    !usingRawAdapters &&
    yearEndPriceNokPerBtc === undefined &&
    !useCoinGecko
  ) {
    throw new Error(
      "Missing required argument: --year-end-price <NOK price per BTC at year-end> (or use --use-coingecko)",
    );
  }

  return {
    miningFile,
    spendsFile,
    goMiningFile,
    bybitFile,
    taxYear,
    yearEndPriceNokPerBtc,
    useCoinGecko,
    outFile,
    skatteetatenOut,
    auditOut,
    openingBtc,
    openingCostBasisNokPerBtc,
  };
}

function formatNok(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

async function resolveTransactions(
  options: CliOptions,
): Promise<ResolvedTransactions> {
  if (options.goMiningFile && options.bybitFile) {
    const goMining = loadGoMiningPayoutsFromCsv(options.goMiningFile);
    const bybit = loadBybitCardSpendsFromCsvWithWarnings(options.bybitFile);

    const pricing = new CoinGeckoPriceService();
    return {
      transactions: await pricing.enrichTransactionsWithNokPrices([
        ...goMining,
        ...bybit.transactions,
      ]),
      warnings: bybit.warnings,
    };
  }

  const miningTransactions = loadTransactionsFromCsv(
    options.miningFile,
    "MINING_PAYOUT",
  );
  const spendTransactions = loadTransactionsFromCsv(
    options.spendsFile,
    "CARD_SPEND",
  );

  return {
    transactions: [...miningTransactions, ...spendTransactions],
    warnings: [],
  };
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
    lines.push(
      headers.map((header) => toCsvValue(row[header] ?? "")).join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function resolveYearEndPrice(options: CliOptions): Promise<number> {
  if (options.yearEndPriceNokPerBtc !== undefined) {
    return options.yearEndPriceNokPerBtc;
  }

  if (!options.useCoinGecko) {
    throw new Error(
      "Year-end price is missing. Provide --year-end-price or enable --use-coingecko.",
    );
  }

  const pricing = new CoinGeckoPriceService();
  return pricing.getYearEndPriceNokPerBtc(options.taxYear);
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { transactions, warnings } = await resolveTransactions(options);
    const yearEndPriceNokPerBtc = await resolveYearEndPrice(options);
    const engine = new NordicTaxEngine();

    const result = engine.processTransactionsDetailed(transactions, {
      taxYear: options.taxYear,
      yearEndPriceNokPerBtc,
      openingBalance:
        options.openingBtc !== undefined &&
        options.openingCostBasisNokPerBtc !== undefined
          ? {
              amountSats: BigInt(Math.round(options.openingBtc * 100_000_000)),
              costBasisNokPerBtc: options.openingCostBasisNokPerBtc,
            }
          : undefined,
    });
    const summary = result.summary;

    const miningCount = transactions.filter(
      (tx) => tx.type === "MINING_PAYOUT",
    ).length;
    const spendCount = transactions.filter(
      (tx) => tx.type === "CARD_SPEND",
    ).length;

    const report = {
      generatedAtUtc: new Date().toISOString(),
      taxYear: summary.taxYear,
      pricingSource: options.useCoinGecko ? "coingecko" : "csv",
      totals: {
        miningIncomeNok: summary.totalMiningIncomeNok,
        capitalGainLossNok: summary.totalCapitalGainLossNok,
        yearEndPortfolioValueNok: summary.yearEndPortfolioValueNok,
        remainingBtcAtYearEnd: Number(summary.remainingBtc.toFixed(8)),
      },
      counts: {
        miningTransactionsInYear: summary.processedMiningTransactions,
        spendTransactionsInYear: summary.processedSpendTransactions,
        miningTransactionsLoaded: miningCount,
        spendTransactionsLoaded: spendCount,
      },
      warnings,
      note: "Informational output only. Verify values before filing with Skatteetaten.",
    };

    console.log("\nNordicTax Report\n");
    console.log(`Tax year: ${summary.taxYear}`);
    console.log(
      `Mining income (NOK): ${formatNok(summary.totalMiningIncomeNok)}`,
    );
    console.log(
      `Capital gain/loss (NOK): ${formatNok(summary.totalCapitalGainLossNok)}`,
    );
    console.log(
      `Year-end portfolio value (NOK): ${formatNok(summary.yearEndPortfolioValueNok)}`,
    );
    console.log(
      `Remaining BTC at year-end: ${summary.remainingBtc.toFixed(8)}`,
    );

    if (options.outFile) {
      const outputPath = path.resolve(options.outFile);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
      console.log(`\nSaved JSON report to ${outputPath}`);
    }

    if (options.skatteetatenOut) {
      const exported = writeSkatteetatenExport(options.skatteetatenOut, {
        summary,
        pricingSource: options.useCoinGecko ? "coingecko" : "csv",
        generatedAtUtc: report.generatedAtUtc,
      });

      console.log(`Saved Skatteetaten JSON export to ${exported.jsonPath}`);
      console.log(`Saved Skatteetaten CSV export to ${exported.csvPath}`);
    }

    if (options.auditOut) {
      const auditPath = path.resolve(options.auditOut);
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });

      const rows: Array<Record<string, string | number>> = [];
      for (const entry of result.auditJournal) {
        for (const lot of entry.consumedLots) {
          rows.push({
            spend_id: entry.transactionId,
            spend_timestamp_utc: entry.timestamp.toISOString(),
            spend_btc: entry.spentBtc.toFixed(8),
            sale_price_nok_per_btc: entry.salePriceNokPerBtc,
            sale_value_nok: entry.saleValueNok,
            lot_id: lot.lotId,
            lot_timestamp_utc: lot.lotTimestamp.toISOString(),
            lot_consumed_btc: lot.consumedBtc.toFixed(8),
            lot_cost_basis_nok_per_btc: lot.lotCostBasisNokPerBtc,
            lot_cost_basis_nok: lot.costBasisNok,
            spend_total_cost_basis_nok: entry.costBasisNok,
            spend_gain_loss_nok: entry.gainLossNok,
          });
        }
      }

      fs.writeFileSync(auditPath, buildCsv(rows), "utf8");
      console.log(`Saved audit journal CSV to ${auditPath}`);
    }

    if (warnings.length > 0) {
      console.log("\nAdapter warnings:");
      for (const warning of warnings) {
        console.log(`- ${warning}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error(`\nError: ${message}\n`);
    console.error("Usage:");
    console.error(
      "  npm run report -- --mining data/mining.csv --spends data/card_spends.csv --tax-year 2026 --year-end-price 950000 --out output/report-2026.json",
    );
    console.error(
      "  npm run report -- --gomining data/gomining.csv --bybit data/bybit.csv --tax-year 2026 --use-coingecko --out output/report-2026.json",
    );
    console.error(
      "  npm run report -- --mining data/mining.csv --spends data/card_spends.csv --tax-year 2026 --year-end-price 950000 --skatteetaten-out output/skatteetaten-2026",
    );
    console.error(
      "  npm run report -- --gomining data/gomining.csv --bybit data/bybit.csv --tax-year 2026 --use-coingecko --opening-btc 0.01 --opening-cost-basis 650000 --audit-out output/audit-journal.csv",
    );
    process.exitCode = 1;
  }
}

void main();

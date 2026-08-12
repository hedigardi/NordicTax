import { NextRequest, NextResponse } from "next/server";
import {
  parseCsvTextWithWarnings,
  PricedTransaction,
  RawTransaction,
  runFifoTax,
} from "../../../lib/tax";
import {
  enrichWithCoinGecko,
  getYearEndPriceFromCoinGecko,
  getLatestNokPriceFromCoinGecko,
} from "../../../lib/coingecko";

interface ReportResponse {
  taxYear: number;
  pricingSource: "csv" | "coingecko";
  filingMode: "draft" | "final";
  totals: {
    miningIncomeNok: number;
    capitalGainLossNok: number;
    yearEndPortfolioValueNok: number;
    remainingBtcAtYearEnd: number;
  };
  skatteetaten: {
    json: Record<string, unknown>;
    csv: string;
    auditJournalCsv: string;
  };
  valuation: {
    kind: "year_end" | "latest_spot";
    priceNokPerBtc: number;
    note: string;
  };
  warnings: string[];
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const mode = form.get("mode")?.toString() === "raw" ? "raw" : "normalized";
    const useCoinGecko = form.get("useCoinGecko")?.toString() === "true";
    const finalFilingMode = form.get("finalFilingMode")?.toString() === "true";
    const taxYear = Number(form.get("taxYear")?.toString() || "0");
    const yearEndPriceRaw = form.get("yearEndPrice")?.toString() || "";
    const openingBtcRaw = form.get("openingBtc")?.toString() || "";
    const openingCostBasisRaw = form.get("openingCostBasis")?.toString() || "";
    const miningFile = form.get("mining") as File | null;
    const spendsFile = form.get("spends") as File | null;

    if (!miningFile || !spendsFile) {
      return NextResponse.json(
        { error: "Both CSV files are required." },
        { status: 400 },
      );
    }

    if (!Number.isInteger(taxYear) || taxYear < 2009) {
      return NextResponse.json({ error: "Invalid tax year." }, { status: 400 });
    }

    const miningCsv = await miningFile.text();
    const spendsCsv = await spendsFile.text();
    const warnings: string[] = [];

    let pricedTransactions: PricedTransaction[];
    let pricingSource: "csv" | "coingecko" = "csv";
    let valuationKind: "year_end" | "latest_spot" = "year_end";
    let valuationNote =
      "Year-end valuation at 31 Dec 23:59 Norway time (22:59 UTC).";

    const hasOpeningBtc = openingBtcRaw.trim().length > 0;
    const hasOpeningCostBasis = openingCostBasisRaw.trim().length > 0;
    if (hasOpeningBtc !== hasOpeningCostBasis) {
      return NextResponse.json(
        {
          error:
            "Opening balance requires both Opening BTC Balance and Opening Cost Basis.",
        },
        { status: 400 },
      );
    }

    const openingBtc = hasOpeningBtc ? Number(openingBtcRaw) : undefined;
    const openingCostBasis = hasOpeningCostBasis
      ? Number(openingCostBasisRaw)
      : undefined;

    if (
      openingBtc !== undefined &&
      (!Number.isFinite(openingBtc) || openingBtc <= 0)
    ) {
      return NextResponse.json(
        { error: "Opening BTC Balance must be a positive number." },
        { status: 400 },
      );
    }

    if (
      openingCostBasis !== undefined &&
      (!Number.isFinite(openingCostBasis) || openingCostBasis <= 0)
    ) {
      return NextResponse.json(
        { error: "Opening Cost Basis must be a positive number." },
        { status: 400 },
      );
    }

    if (mode === "normalized") {
      const miningParsed = parseCsvTextWithWarnings(
        miningCsv,
        "MINING_PAYOUT",
        "normalized",
      );
      const spendsParsed = parseCsvTextWithWarnings(
        spendsCsv,
        "CARD_SPEND",
        "normalized",
      );
      warnings.push(...miningParsed.warnings, ...spendsParsed.warnings);
      const mining = miningParsed.transactions as PricedTransaction[];
      const spends = spendsParsed.transactions as PricedTransaction[];
      pricedTransactions = [...mining, ...spends];
    } else {
      const miningRawParsed = parseCsvTextWithWarnings(
        miningCsv,
        "MINING_PAYOUT",
        "raw",
      );
      const spendsRawParsed = parseCsvTextWithWarnings(
        spendsCsv,
        "CARD_SPEND",
        "raw",
      );
      warnings.push(...miningRawParsed.warnings, ...spendsRawParsed.warnings);

      const miningRaw = miningRawParsed.transactions as RawTransaction[];
      const spendsRaw = spendsRawParsed.transactions as RawTransaction[];

      if (!useCoinGecko) {
        return NextResponse.json(
          { error: "Raw mode requires CoinGecko pricing." },
          { status: 400 },
        );
      }

      pricedTransactions = await enrichWithCoinGecko([
        ...miningRaw,
        ...spendsRaw,
      ]);
      pricingSource = "coingecko";
    }

    let yearEndPrice = Number(yearEndPriceRaw);
    if (!Number.isFinite(yearEndPrice) || yearEndPrice <= 0) {
      if (!useCoinGecko) {
        return NextResponse.json(
          {
            error:
              "Provide a valid year-end BTC/NOK price or enable CoinGecko.",
          },
          { status: 400 },
        );
      }
      try {
        yearEndPrice = await getYearEndPriceFromCoinGecko(taxYear);
        pricingSource = "coingecko";
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        if (message.includes("future tax year")) {
          if (finalFilingMode) {
            return NextResponse.json(
              {
                error:
                  "Final filing mode requires a final year-end BTC/NOK price. Add a manual year-end price for in-progress tax years.",
              },
              { status: 400 },
            );
          }

          yearEndPrice = await getLatestNokPriceFromCoinGecko();
          pricingSource = "coingecko";
          valuationKind = "latest_spot";
          valuationNote =
            "Tax year is in progress. Using latest available BTC/NOK spot price as temporary valuation.";
        } else {
          throw error;
        }
      }
    }

    const result = runFifoTax(pricedTransactions, taxYear, yearEndPrice, {
      openingBalance:
        openingBtc !== undefined && openingCostBasis !== undefined
          ? {
              amountSats: BigInt(Math.round(openingBtc * 100_000_000)),
              costBasisNokPerBtc: openingCostBasis,
            }
          : undefined,
    });
    const summary = result.summary;

    if (finalFilingMode && valuationKind !== "year_end") {
      return NextResponse.json(
        {
          error:
            "Final filing mode cannot use temporary latest spot valuation. Provide a final year-end price.",
        },
        { status: 400 },
      );
    }

    const response: ReportResponse = {
      taxYear,
      pricingSource,
      filingMode: finalFilingMode ? "final" : "draft",
      totals: {
        miningIncomeNok: summary.miningIncomeNok,
        capitalGainLossNok: summary.capitalGainLossNok,
        yearEndPortfolioValueNok: summary.yearEndPortfolioValueNok,
        remainingBtcAtYearEnd: Number(summary.remainingBtc.toFixed(8)),
      },
      skatteetaten: {
        json: {
          taxYear,
          pricingSource,
          sections: {
            kapitalinntekt: {
              miningIncomeNok: summary.miningIncomeNok,
            },
            realisasjon: {
              capitalGainLossNok: summary.capitalGainLossNok,
            },
            formue31desember: {
              yearEndPortfolioValueNok: summary.yearEndPortfolioValueNok,
              remainingBtc: Number(summary.remainingBtc.toFixed(8)),
            },
          },
        },
        csv: buildCsv([
          {
            tax_year: taxYear,
            field: "mining_income_nok",
            value: summary.miningIncomeNok,
            category: "kapitalinntekt",
          },
          {
            tax_year: taxYear,
            field: "capital_gain_loss_nok",
            value: summary.capitalGainLossNok,
            category: "realisasjon",
          },
          {
            tax_year: taxYear,
            field: "year_end_portfolio_value_nok",
            value: summary.yearEndPortfolioValueNok,
            category: "formue_31_12",
          },
          {
            tax_year: taxYear,
            field: "remaining_btc_31_12",
            value: Number(summary.remainingBtc.toFixed(8)),
            category: "formue_31_12",
          },
        ]),
        auditJournalCsv: buildCsv(
          result.auditJournal.flatMap((entry) =>
            entry.consumedLots.map((lot) => ({
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
            })),
          ),
        ),
      },
      valuation: {
        kind: valuationKind,
        priceNokPerBtc: yearEndPrice,
        note: valuationNote,
      },
      warnings,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const userFixableError =
      message.includes("Normalized mode requires nok_price_per_btc") ||
      message.includes("CSV parse error") ||
      message.includes("Invalid timestamp") ||
      message.includes("Invalid amount_btc") ||
      message.includes("Insufficient BTC inventory") ||
      message.includes("Year-end price is not available yet") ||
      message.includes("raw mode") ||
      message.includes("CoinGecko");

    return NextResponse.json(
      {
        error: message,
      },
      { status: userFixableError ? 400 : 500 },
    );
  }
}

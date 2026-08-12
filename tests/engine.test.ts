import { describe, expect, it } from "vitest";
import { NordicTaxEngine } from "../src/engine.js";
import { CryptoTransaction, SATOSHIS_PER_BTC } from "../src/types.js";

function tx(
  id: string,
  type: "MINING_PAYOUT" | "CARD_SPEND",
  btc: number,
  price: number,
  timestamp: string,
): CryptoTransaction {
  return {
    id,
    type,
    timestamp: new Date(timestamp),
    amountSats: BigInt(Math.round(btc * Number(SATOSHIS_PER_BTC))),
    nokPricePerBtc: price,
  };
}

describe("NordicTaxEngine", () => {
  it("calculates FIFO gain/loss and year-end wealth", () => {
    const engine = new NordicTaxEngine();
    const summary = engine.processTransactions(
      [
        tx("m1", "MINING_PAYOUT", 0.001, 700000, "2026-01-02T00:00:00Z"),
        tx("m2", "MINING_PAYOUT", 0.001, 800000, "2026-01-03T00:00:00Z"),
        tx("s1", "CARD_SPEND", 0.0015, 900000, "2026-01-10T00:00:00Z"),
      ],
      {
        taxYear: 2026,
        yearEndPriceNokPerBtc: 950000,
      },
    );

    expect(summary.totalMiningIncomeNok).toBe(1500);
    expect(summary.totalCapitalGainLossNok).toBe(250);
    expect(summary.remainingBtc.toFixed(8)).toBe("0.00050000");
    expect(summary.yearEndPortfolioValueNok).toBe(475);
  });

  it("throws on spend bigger than mined inventory", () => {
    const engine = new NordicTaxEngine();
    expect(() =>
      engine.processTransactions(
        [
          tx("m1", "MINING_PAYOUT", 0.0001, 700000, "2026-01-02T00:00:00Z"),
          tx("s1", "CARD_SPEND", 0.001, 900000, "2026-01-03T00:00:00Z"),
        ],
        {
          taxYear: 2026,
          yearEndPriceNokPerBtc: 950000,
        },
      ),
    ).toThrow(/Insufficient BTC inventory/);
  });

  it("supports opening balance lot without counting it as mining income", () => {
    const engine = new NordicTaxEngine();
    const summary = engine.processTransactions(
      [tx("s1", "CARD_SPEND", 0.001, 900000, "2026-01-03T00:00:00Z")],
      {
        taxYear: 2026,
        yearEndPriceNokPerBtc: 950000,
        openingBalance: {
          amountSats: BigInt(Math.round(0.002 * Number(SATOSHIS_PER_BTC))),
          costBasisNokPerBtc: 700000,
        },
      },
    );

    expect(summary.totalMiningIncomeNok).toBe(0);
    expect(summary.totalCapitalGainLossNok).toBe(200);
    expect(summary.remainingBtc.toFixed(8)).toBe("0.00100000");
  });

  it("returns audit journal with consumed FIFO lots per spend", () => {
    const engine = new NordicTaxEngine();
    const result = engine.processTransactionsDetailed(
      [
        tx("m1", "MINING_PAYOUT", 0.001, 700000, "2026-01-02T00:00:00Z"),
        tx("m2", "MINING_PAYOUT", 0.001, 800000, "2026-01-03T00:00:00Z"),
        tx("s1", "CARD_SPEND", 0.0015, 900000, "2026-01-10T00:00:00Z"),
      ],
      {
        taxYear: 2026,
        yearEndPriceNokPerBtc: 950000,
      },
    );

    expect(result.auditJournal).toHaveLength(1);
    expect(result.auditJournal[0]?.transactionId).toBe("s1");
    expect(result.auditJournal[0]?.consumedLots).toHaveLength(2);
    expect(result.auditJournal[0]?.gainLossNok).toBe(250);
  });
});

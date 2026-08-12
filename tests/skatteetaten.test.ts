import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSkatteetatenPayload,
  writeSkatteetatenExport,
} from "../src/skatteetaten.js";

describe("Skatteetaten export", () => {
  it("creates payload with expected sections", () => {
    const payload = createSkatteetatenPayload({
      generatedAtUtc: "2026-08-12T00:00:00.000Z",
      pricingSource: "csv",
      summary: {
        taxYear: 2026,
        totalMiningIncomeNok: 1000,
        totalCapitalGainLossNok: 200,
        yearEndPortfolioValueNok: 300,
        remainingBtc: 0.0004,
        processedMiningTransactions: 10,
        processedSpendTransactions: 9,
      },
    });

    expect(payload).toMatchObject({
      taxYear: 2026,
      sections: {
        kapitalinntekt: { miningIncomeNok: 1000 },
        realisasjon: { capitalGainLossNok: 200 },
      },
    });
  });

  it("writes both json and csv files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordictax-sk-"));
    const base = path.join(dir, "skatteetaten-2026");

    try {
      const result = writeSkatteetatenExport(base, {
        generatedAtUtc: "2026-08-12T00:00:00.000Z",
        pricingSource: "coingecko",
        summary: {
          taxYear: 2026,
          totalMiningIncomeNok: 1000,
          totalCapitalGainLossNok: 200,
          yearEndPortfolioValueNok: 300,
          remainingBtc: 0.0004,
          processedMiningTransactions: 10,
          processedSpendTransactions: 9,
        },
      });

      expect(fs.existsSync(result.jsonPath)).toBe(true);
      expect(fs.existsSync(result.csvPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

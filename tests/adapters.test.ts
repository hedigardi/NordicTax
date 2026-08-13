import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadBybitCardSpendsFromCsv,
  loadGoMiningPayoutsFromCsv,
} from "../src/adapters.js";

function withTempFile(content: string, run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordictax-test-"));
  const filePath = path.join(dir, "input.csv");
  fs.writeFileSync(filePath, content, "utf8");
  try {
    run(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("CSV adapters", () => {
  it("parses official gomining income/date export shape", () => {
    const csv = [
      "date,income,status,toAddress",
      "2026-08-11T00:00:00.000Z,0.00010749,exported,V0215",
      "2026-08-10T00:00:00.000Z,0.00011355,exported,V0215",
    ].join("\n");

    withTempFile(csv, (filePath) => {
      const rows = loadGoMiningPayoutsFromCsv(filePath);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.type).toBe("MINING_PAYOUT");
    });
  });

  it("parses gomining payout rows and skips non-payout records", () => {
    const csv = [
      "id,timestamp,amount_btc,type,description",
      "1,2026-01-02T00:00:00Z,0.0005,mining_reward,daily payout",
      "2,2026-01-02T01:00:00Z,-0.00001,fee,service fee",
    ].join("\n");

    withTempFile(csv, (filePath) => {
      const rows = loadGoMiningPayoutsFromCsv(filePath);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("MINING_PAYOUT");
    });
  });

  it("parses gomining gross reward with c1/c2 service and electricity fees", () => {
    const csv = [
      "id,timestamp,income,c1,c2,status",
      "1,2026-01-02T00:00:00Z,0.00050000,0.00002000,0.00001000,exported",
    ].join("\n");

    withTempFile(csv, (filePath) => {
      const rows = loadGoMiningPayoutsFromCsv(filePath);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.amountSats).toBe(BigInt(50000));
      expect(rows[0]?.grossAmountSats).toBe(BigInt(53000));
      expect(rows[0]?.feeSats).toBe(BigInt(3000));
    });
  });

  it("parses bybit spend rows and skips transfers/deposits", () => {
    const csv = [
      "id,timestamp,amount_btc,description",
      "1,2026-01-10T00:00:00Z,-0.0002,card purchase",
      "2,2026-01-11T00:00:00Z,0.0003,internal transfer",
    ].join("\n");

    withTempFile(csv, (filePath) => {
      const rows = loadBybitCardSpendsFromCsv(filePath);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("CARD_SPEND");
    });
  });

  it("parses bybit export with UID metadata first row", () => {
    const csv = [
      "UID: 1977928,Name: TEST USER,Company Name: ,Country: ",
      "Uid,Date & Time(UTC),Coin,QTY,Type,Account Balance,Description",
      "1977928,2026-08-11 15:02:50,BTC,-0.00042233,Bybit Card,0.0002469,Purchase",
      "1977928,2026-08-11 15:02:51,USD,-26.48,Bybit Card,0,Purchase",
    ].join("\n");

    withTempFile(csv, (filePath) => {
      const rows = loadBybitCardSpendsFromCsv(filePath);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("CARD_SPEND");
    });
  });
});

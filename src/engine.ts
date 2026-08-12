import {
  AuditJournalEntry,
  AuditLotConsumption,
  CryptoTransaction,
  EngineConfig,
  MiningLot,
  SATOSHIS_PER_BTC,
  TaxComputationResult,
  TaxSummary,
} from "./types.js";

function toBtc(sats: bigint): number {
  return Number(sats) / Number(SATOSHIS_PER_BTC);
}

function roundNok(value: number): number {
  return Math.round(value * 100) / 100;
}

function isWithinTaxYear(timestamp: Date, taxYear: number): boolean {
  return timestamp.getUTCFullYear() === taxYear;
}

function getTaxYearEndUtc(taxYear: number): Date {
  return new Date(Date.UTC(taxYear, 11, 31, 22, 59, 59, 999));
}

export class NordicTaxEngine {
  private readonly fifoQueue: MiningLot[] = [];

  public processTransactions(
    transactions: CryptoTransaction[],
    config: EngineConfig,
  ): TaxSummary {
    return this.processTransactionsDetailed(transactions, config).summary;
  }

  public processTransactionsDetailed(
    transactions: CryptoTransaction[],
    config: EngineConfig,
  ): TaxComputationResult {
    this.fifoQueue.length = 0;

    if (config.openingBalance) {
      this.fifoQueue.push({
        id: "opening_balance_lot",
        timestamp: new Date(Date.UTC(config.taxYear, 0, 1, 0, 0, 0, 0)),
        remainingSats: config.openingBalance.amountSats,
        costBasisNokPerBtc: config.openingBalance.costBasisNokPerBtc,
      });
    }

    const sorted = [...transactions].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const yearEnd = getTaxYearEndUtc(config.taxYear);

    let totalMiningIncomeNok = 0;
    let totalCapitalGainLossNok = 0;
    let processedMiningTransactions = 0;
    let processedSpendTransactions = 0;
    const auditJournal: AuditJournalEntry[] = [];

    for (const tx of sorted) {
      if (tx.timestamp > yearEnd) {
        break;
      }

      if (tx.type === "MINING_PAYOUT") {
        const income = this.processMiningPayout(tx);

        if (isWithinTaxYear(tx.timestamp, config.taxYear)) {
          totalMiningIncomeNok += income;
          processedMiningTransactions += 1;
        }

        continue;
      }

      const spendResult = this.processCardSpendDetailed(tx);

      if (isWithinTaxYear(tx.timestamp, config.taxYear)) {
        totalCapitalGainLossNok += spendResult.gainLossNok;
        processedSpendTransactions += 1;
        auditJournal.push({
          transactionId: tx.id,
          timestamp: tx.timestamp,
          spentSats: tx.amountSats,
          spentBtc: toBtc(tx.amountSats),
          salePriceNokPerBtc: tx.nokPricePerBtc,
          saleValueNok: roundNok(toBtc(tx.amountSats) * tx.nokPricePerBtc),
          costBasisNok: roundNok(spendResult.costBasisNok),
          gainLossNok: roundNok(spendResult.gainLossNok),
          consumedLots: spendResult.consumedLots,
        });
      }
    }

    const remainingSats = this.fifoQueue.reduce(
      (sum, lot) => sum + lot.remainingSats,
      0n,
    );

    const remainingBtc = toBtc(remainingSats);
    const yearEndPortfolioValueNok =
      remainingBtc * config.yearEndPriceNokPerBtc;

    return {
      summary: {
        taxYear: config.taxYear,
        totalMiningIncomeNok: roundNok(totalMiningIncomeNok),
        totalCapitalGainLossNok: roundNok(totalCapitalGainLossNok),
        yearEndPortfolioValueNok: roundNok(yearEndPortfolioValueNok),
        remainingBtc,
        processedMiningTransactions,
        processedSpendTransactions,
      },
      auditJournal,
    };
  }

  public processMiningPayout(tx: CryptoTransaction): number {
    const amountBtc = toBtc(tx.amountSats);
    const incomeNok = amountBtc * tx.nokPricePerBtc;

    this.fifoQueue.push({
      id: tx.id,
      timestamp: tx.timestamp,
      remainingSats: tx.amountSats,
      costBasisNokPerBtc: tx.nokPricePerBtc,
    });

    return incomeNok;
  }

  public processCardSpend(tx: CryptoTransaction): number {
    return this.processCardSpendDetailed(tx).gainLossNok;
  }

  private processCardSpendDetailed(tx: CryptoTransaction): {
    gainLossNok: number;
    costBasisNok: number;
    consumedLots: AuditLotConsumption[];
  } {
    let satsToSell = tx.amountSats;
    const saleValueNok = toBtc(tx.amountSats) * tx.nokPricePerBtc;
    let totalCostBasisNok = 0;
    const consumedLots: AuditLotConsumption[] = [];

    while (satsToSell > 0n && this.fifoQueue.length > 0) {
      const currentLot = this.fifoQueue[0];

      if (!currentLot) {
        break;
      }

      if (currentLot.remainingSats <= satsToSell) {
        const consumedSats = currentLot.remainingSats;
        satsToSell -= consumedSats;
        const consumedCost =
          toBtc(consumedSats) * currentLot.costBasisNokPerBtc;
        totalCostBasisNok += consumedCost;
        consumedLots.push({
          lotId: currentLot.id,
          lotTimestamp: currentLot.timestamp,
          consumedSats,
          consumedBtc: toBtc(consumedSats),
          lotCostBasisNokPerBtc: currentLot.costBasisNokPerBtc,
          costBasisNok: roundNok(consumedCost),
        });
        this.fifoQueue.shift();
      } else {
        const consumedSats = satsToSell;
        const consumedCost =
          toBtc(consumedSats) * currentLot.costBasisNokPerBtc;
        totalCostBasisNok += consumedCost;
        consumedLots.push({
          lotId: currentLot.id,
          lotTimestamp: currentLot.timestamp,
          consumedSats,
          consumedBtc: toBtc(consumedSats),
          lotCostBasisNokPerBtc: currentLot.costBasisNokPerBtc,
          costBasisNok: roundNok(consumedCost),
        });
        currentLot.remainingSats -= consumedSats;
        satsToSell = 0n;
      }
    }

    if (satsToSell > 0n) {
      throw new Error(
        `Insufficient BTC inventory for spend transaction ${tx.id}. Missing ${toBtc(satsToSell).toFixed(8)} BTC.`,
      );
    }

    return {
      gainLossNok: saleValueNok - totalCostBasisNok,
      costBasisNok: totalCostBasisNok,
      consumedLots,
    };
  }
}

export const SATOSHIS_PER_BTC = 100_000_000n;

export type TransactionType = "MINING_PAYOUT" | "CARD_SPEND";

export interface CryptoTransaction {
  id: string;
  timestamp: Date;
  type: TransactionType;
  amountSats: bigint;
  nokPricePerBtc: number;
}

export interface RawCryptoTransaction {
  id: string;
  timestamp: Date;
  type: TransactionType;
  amountSats: bigint;
}

export interface MiningLot {
  id: string;
  timestamp: Date;
  remainingSats: bigint;
  costBasisNokPerBtc: number;
}

export interface TaxSummary {
  taxYear: number;
  totalMiningIncomeNok: number;
  totalCapitalGainLossNok: number;
  yearEndPortfolioValueNok: number;
  remainingBtc: number;
  processedMiningTransactions: number;
  processedSpendTransactions: number;
}

export interface OpeningBalance {
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

export interface EngineConfig {
  taxYear: number;
  yearEndPriceNokPerBtc: number;
  openingBalance?: OpeningBalance;
}

export interface CsvTransactionRow {
  id?: string;
  timestamp: string;
  amount_btc: string;
  nok_price_per_btc: string;
}

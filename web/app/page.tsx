"use client";

import { FormEvent, useEffect, useState } from "react";

type WarningCategory =
  | "all"
  | "dedupe"
  | "dust"
  | "net_outflow"
  | "unsupported"
  | "other";

type ThemeMode = "light" | "dark";

const WARNING_FILTER_STORAGE_KEY = "nordictax.warningFilter";
const WARNING_PANEL_OPEN_STORAGE_KEY = "nordictax.warningPanelOpen";
const THEME_STORAGE_KEY = "nordictax.theme";
const WARNING_CATEGORIES: WarningCategory[] = [
  "all",
  "dedupe",
  "dust",
  "net_outflow",
  "unsupported",
  "other",
];
const MAX_CSV_FILE_SIZE_BYTES = 4 * 1024 * 1024;

function isWarningCategory(value: string): value is WarningCategory {
  return WARNING_CATEGORIES.includes(value as WarningCategory);
}

interface ApiResponse {
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

function formatNok(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatWholeNok(value: number): string {
  return new Intl.NumberFormat("nb-NO", {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function formatBtcAmount(value: number): string {
  return value.toFixed(8);
}

function formatBtcForNorwegianInput(value: number): string {
  return value.toFixed(8).replace(".", ",");
}

function formatFileSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}

function classifyWarning(message: string): Exclude<WarningCategory, "all"> {
  const text = message.toLowerCase();

  if (text.includes("deduped")) {
    return "dedupe";
  }

  if (text.includes("dust-level")) {
    return "dust";
  }

  if (text.includes("net outflow") || text.includes("qty < 0")) {
    return "net_outflow";
  }

  if (text.includes("unsupported description")) {
    return "unsupported";
  }

  return "other";
}

function categoryLabel(category: WarningCategory): string {
  if (category === "all") {
    return "All";
  }
  if (category === "dedupe") {
    return "Deduped";
  }
  if (category === "dust") {
    return "Dust";
  }
  if (category === "net_outflow") {
    return "Net outflow";
  }
  if (category === "unsupported") {
    return "Unsupported";
  }
  return "Other";
}

function isThemeMode(value: string): value is ThemeMode {
  return value === "light" || value === "dark";
}

function resolveInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved && isThemeMode(saved)) {
    return saved;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export default function Page() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [mode, setMode] = useState<"normalized" | "raw">("raw");
  const [useCoinGecko, setUseCoinGecko] = useState(true);
  const [finalFilingMode, setFinalFilingMode] = useState(false);
  const [warningFilter, setWarningFilter] = useState<WarningCategory>(() => {
    if (typeof window === "undefined") {
      return "all";
    }

    const saved = window.localStorage.getItem(WARNING_FILTER_STORAGE_KEY);
    return saved && isWarningCategory(saved) ? saved : "all";
  });
  const [isWarningPanelOpen, setIsWarningPanelOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }

    const saved = window.localStorage.getItem(WARNING_PANEL_OPEN_STORAGE_KEY);
    return saved === null ? true : saved === "true";
  });
  const [copiedFieldKey, setCopiedFieldKey] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(resolveInitialTheme);

  useEffect(() => {
    window.localStorage.setItem(WARNING_FILTER_STORAGE_KEY, warningFilter);
  }, [warningFilter]);

  useEffect(() => {
    window.localStorage.setItem(
      WARNING_PANEL_OPEN_STORAGE_KEY,
      String(isWarningPanelOpen),
    );
  }, [isWarningPanelOpen]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  function downloadText(content: string, fileName: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyToClipboard(
    value: string,
    fieldKey: string,
  ): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = value;
        textArea.setAttribute("readonly", "true");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }

      setCopiedFieldKey(fieldKey);
      window.setTimeout(() => {
        setCopiedFieldKey((current) => (current === fieldKey ? null : current));
      }, 1300);
    } catch {
      setError("Could not copy value to clipboard. Please copy manually.");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const form = event.currentTarget;
      const data = new FormData(form);

      const miningFile = data.get("mining");
      if (
        miningFile instanceof File &&
        miningFile.size > MAX_CSV_FILE_SIZE_BYTES
      ) {
        throw new Error(
          `GoMining CSV is too large (${formatFileSize(miningFile.size)}). Keep each CSV under ${formatFileSize(MAX_CSV_FILE_SIZE_BYTES)} for reliable Netlify processing.`,
        );
      }

      const spendsFile = data.get("spends");
      if (
        spendsFile instanceof File &&
        spendsFile.size > MAX_CSV_FILE_SIZE_BYTES
      ) {
        throw new Error(
          `Bybit CSV is too large (${formatFileSize(spendsFile.size)}). Keep each CSV under ${formatFileSize(MAX_CSV_FILE_SIZE_BYTES)} for reliable Netlify processing.`,
        );
      }

      const taxYear = Number(data.get("taxYear")?.toString() || "0");
      const yearEndPriceRaw = data.get("yearEndPrice")?.toString().trim() || "";

      if (
        finalFilingMode &&
        taxYear >= new Date().getUTCFullYear() &&
        yearEndPriceRaw.length === 0
      ) {
        throw new Error(
          "Final filing mode requires a manual year-end BTC/NOK price for an in-progress tax year.",
        );
      }

      data.set("mode", mode);
      data.set("useCoinGecko", String(useCoinGecko));
      data.set("finalFilingMode", String(finalFilingMode));

      const response = await fetch("/api/report", {
        method: "POST",
        body: data,
      });

      const json = (await response.json()) as ApiResponse | { error: string };
      if (!response.ok) {
        throw new Error(
          "error" in json ? json.error : "Failed to calculate report",
        );
      }

      setResult(json as ApiResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header className="topbar card">
        <div className="brand-wrap">
          <img className="brand-logo" src="/logo.png" alt="NordicTax logo" />
          <div>
            <p className="brand-kicker">Norway Crypto Tax Workflow</p>
            <h1 className="brand-title">NordicTax</h1>
          </div>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() =>
            setTheme((current) => (current === "light" ? "dark" : "light"))
          }
          aria-label="Toggle light and dark theme"
        >
          {theme === "light" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-icon">
              <path
                d="M12 3.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V4.5a.75.75 0 0 1 .75-.75Zm0 14.25a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75Zm8.25-6.75a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5Zm-14.25 0a.75.75 0 0 1 0 1.5H4.5a.75.75 0 0 1 0-1.5H6Zm9.546-5.796a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 1 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061Zm-8.143 8.144a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 1 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061Zm10.264 1.06a.75.75 0 0 1 0 1.061l-1.06 1.06a.75.75 0 1 1-1.062-1.06l1.061-1.061a.75.75 0 0 1 1.061 0Zm-8.143-8.144a.75.75 0 0 1 0 1.061l-1.06 1.06a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5Z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-icon">
              <path
                d="M13.29 2.295a.75.75 0 0 1 .91.908 7.5 7.5 0 1 0 9.596 9.597.75.75 0 0 1 .908.91A9.001 9.001 0 1 1 13.29 2.295Z"
                fill="currentColor"
              />
            </svg>
          )}
          <span className="sr-only">
            {theme === "light"
              ? "Switch to dark theme"
              : "Switch to light theme"}
          </span>
        </button>
      </header>

      <section className="hero">
        <h2>From raw exchange exports to filing-ready numbers</h2>
        <p>
          Upload your GoMining and Bybit CSV files, choose pricing mode, and
          generate a FIFO-based annual report for mining income, capital
          gain/loss, and year-end wealth.
        </p>
      </section>

      <form
        className="card grid"
        onSubmit={onSubmit}
        method="post"
        action="/api/report"
        encType="multipart/form-data"
      >
        <div className="grid two">
          <label>
            Tax year
            <input
              name="taxYear"
              type="number"
              defaultValue={new Date().getUTCFullYear()}
              min={2009}
              required
            />
          </label>

          <label>
            CSV mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "normalized" | "raw")}
            >
              <option value="normalized">
                Normalized (requires nok_price_per_btc in both CSV files)
              </option>
              <option value="raw">
                Raw adapter mode (GoMining/Bybit official exports)
              </option>
            </select>
          </label>
        </div>

        <div className="grid two">
          <label>
            GoMining payouts CSV
            <input name="mining" type="file" accept=".csv,text/csv" required />
          </label>

          <label>
            Bybit card spends CSV
            <input name="spends" type="file" accept=".csv,text/csv" required />
          </label>
        </div>

        <p className="upload-limit-note">
          Netlify-safe upload tip: keep each CSV under{" "}
          {formatFileSize(MAX_CSV_FILE_SIZE_BYTES)}.
        </p>

        <div className="grid two">
          <label>
            Year-end BTC/NOK price (optional if CoinGecko is enabled)
            <input
              name="yearEndPrice"
              type="number"
              step="0.01"
              placeholder="950000"
            />
          </label>

          <label>
            Opening BTC Balance at Jan 1 (optional)
            <input
              name="openingBtc"
              type="number"
              step="0.00000001"
              placeholder="0.01000000"
            />
          </label>
        </div>

        <div className="grid two">
          <label>
            Opening Cost Basis (NOK/BTC, required if opening balance is set)
            <input
              name="openingCostBasis"
              type="number"
              step="0.01"
              placeholder="650000"
            />
          </label>

          <label>
            CoinGecko pricing
            <span className="inline">
              <input
                type="checkbox"
                checked={useCoinGecko}
                onChange={(e) => setUseCoinGecko(e.target.checked)}
              />
              Enable automatic timestamp pricing and year-end fallback
              (recommended for raw mode)
            </span>
          </label>
        </div>

        <div className="grid two">
          <label>
            Final filing mode (strict)
            <span className="inline">
              <input
                type="checkbox"
                checked={finalFilingMode}
                onChange={(e) => setFinalFilingMode(e.target.checked)}
              />
              Block temporary latest spot valuation; require final year-end
              valuation
            </span>
          </label>
        </div>

        <button disabled={loading} type="submit">
          {loading ? "Calculating..." : "Generate report"}
        </button>
      </form>

      {error && (
        <section className="card" style={{ marginTop: 16 }}>
          <strong>Error</strong>
          <p>{error}</p>
        </section>
      )}

      {result && (
        <section className="card" style={{ marginTop: 16 }}>
          {(() => {
            const categorizedWarnings = result.warnings.map((message) => ({
              message,
              category: classifyWarning(message),
            }));

            const counts = {
              all: categorizedWarnings.length,
              dedupe: categorizedWarnings.filter((w) => w.category === "dedupe")
                .length,
              dust: categorizedWarnings.filter((w) => w.category === "dust")
                .length,
              net_outflow: categorizedWarnings.filter(
                (w) => w.category === "net_outflow",
              ).length,
              unsupported: categorizedWarnings.filter(
                (w) => w.category === "unsupported",
              ).length,
              other: categorizedWarnings.filter((w) => w.category === "other")
                .length,
            };

            const visibleWarnings =
              warningFilter === "all"
                ? categorizedWarnings
                : categorizedWarnings.filter(
                    (warning) => warning.category === warningFilter,
                  );

            const warningTabs = WARNING_CATEGORIES;

            return (
              <>
                <h2 style={{ marginTop: 0 }}>Report ({result.taxYear})</h2>
                <div className="metrics">
                  <article className="metric">
                    <h3>Mining income (NOK)</h3>
                    <p>{formatNok(result.totals.miningIncomeNok)}</p>
                  </article>
                  <article className="metric">
                    <h3>Capital gain/loss (NOK)</h3>
                    <p>{formatNok(result.totals.capitalGainLossNok)}</p>
                  </article>
                  <article className="metric">
                    <h3>Year-end portfolio (NOK)</h3>
                    <p>{formatNok(result.totals.yearEndPortfolioValueNok)}</p>
                  </article>
                </div>
                <p>
                  Remaining BTC at year-end:{" "}
                  <strong>
                    {result.totals.remainingBtcAtYearEnd.toFixed(8)}
                  </strong>
                </p>
                <p>
                  Pricing source: <strong>{result.pricingSource}</strong>
                </p>
                <p>
                  Filing mode: <strong>{result.filingMode}</strong>
                </p>
                <p>
                  Valuation basis: <strong>{result.valuation.kind}</strong> at{" "}
                  <strong>
                    {formatNok(result.valuation.priceNokPerBtc)} NOK/BTC
                  </strong>
                </p>
                <p>{result.valuation.note}</p>

                {(() => {
                  const roundedMiningIncome = Math.round(
                    result.totals.miningIncomeNok,
                  );
                  const roundedPortfolioValue = Math.round(
                    result.totals.yearEndPortfolioValueNok,
                  );
                  const roundedGainLoss = Math.round(
                    result.totals.capitalGainLossNok,
                  );
                  const totalGain = roundedGainLoss > 0 ? roundedGainLoss : 0;
                  const totalLoss =
                    roundedGainLoss < 0 ? Math.abs(roundedGainLoss) : 0;

                  return (
                    <section className="filing-assistant">
                      <h3>Skatteetaten Filing Assistant</h3>
                      <p>
                        Enter values under <strong>Finans</strong> and then
                        <strong> Virtuell valuta (kryptovaluta)</strong>. NOK
                        values are rounded to whole kroner.
                      </p>

                      <div className="filing-table-wrap">
                        <table className="filing-table">
                          <thead>
                            <tr>
                              <th>NordicTax CSV field</th>
                              <th>Calculated value</th>
                              <th>Skatteetaten field</th>
                              <th>Value to enter</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>mining_income_nok</td>
                              <td>
                                {formatNok(result.totals.miningIncomeNok)} NOK
                              </td>
                              <td>Inntekt (skattepliktig avkastning/mining)</td>
                              <td>
                                <div className="copy-field-row">
                                  <span>
                                    {formatWholeNok(roundedMiningIncome)} kr
                                  </span>
                                  <button
                                    type="button"
                                    className="copy-button"
                                    onClick={() =>
                                      copyToClipboard(
                                        String(roundedMiningIncome),
                                        "mining_income",
                                      )
                                    }
                                  >
                                    {copiedFieldKey === "mining_income"
                                      ? "Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                              </td>
                            </tr>
                            <tr>
                              <td>capital_gain_loss_nok</td>
                              <td>
                                {formatNok(result.totals.capitalGainLossNok)}{" "}
                                NOK
                              </td>
                              <td>Gevinst og tap</td>
                              <td>
                                <div className="copy-field-row">
                                  <span>
                                    Samlet gevinst: {formatWholeNok(totalGain)}{" "}
                                    kr
                                  </span>
                                  <button
                                    type="button"
                                    className="copy-button"
                                    onClick={() =>
                                      copyToClipboard(
                                        String(totalGain),
                                        "capital_gain_gain",
                                      )
                                    }
                                  >
                                    {copiedFieldKey === "capital_gain_gain"
                                      ? "Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                                <div className="copy-field-row">
                                  <span>
                                    Samlet tap: {formatWholeNok(totalLoss)} kr
                                  </span>
                                  <button
                                    type="button"
                                    className="copy-button"
                                    onClick={() =>
                                      copyToClipboard(
                                        String(totalLoss),
                                        "capital_gain_loss",
                                      )
                                    }
                                  >
                                    {copiedFieldKey === "capital_gain_loss"
                                      ? "Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                              </td>
                            </tr>
                            <tr>
                              <td>year_end_portfolio_value_nok</td>
                              <td>
                                {formatNok(
                                  result.totals.yearEndPortfolioValueNok,
                                )}{" "}
                                NOK
                              </td>
                              <td>Formuesverdi per 31.12</td>
                              <td>
                                <div className="copy-field-row">
                                  <span>
                                    {formatWholeNok(roundedPortfolioValue)} kr
                                  </span>
                                  <button
                                    type="button"
                                    className="copy-button"
                                    onClick={() =>
                                      copyToClipboard(
                                        String(roundedPortfolioValue),
                                        "portfolio_value",
                                      )
                                    }
                                  >
                                    {copiedFieldKey === "portfolio_value"
                                      ? "Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                              </td>
                            </tr>
                            <tr>
                              <td>remaining_btc_31_12</td>
                              <td>
                                {formatBtcAmount(
                                  result.totals.remainingBtcAtYearEnd,
                                )}{" "}
                                BTC
                              </td>
                              <td>Antall</td>
                              <td>
                                <div className="copy-field-row">
                                  <span>
                                    {formatBtcForNorwegianInput(
                                      result.totals.remainingBtcAtYearEnd,
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    className="copy-button"
                                    onClick={() =>
                                      copyToClipboard(
                                        formatBtcForNorwegianInput(
                                          result.totals.remainingBtcAtYearEnd,
                                        ),
                                        "remaining_btc",
                                      )
                                    }
                                  >
                                    {copiedFieldKey === "remaining_btc"
                                      ? "Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      <ol className="filing-steps">
                        <li>
                          Open Finans and select Legg til virtuell valuta /
                          kryptovaluta.
                        </li>
                        <li>
                          Use a name like Bitcoin (BTC) or NordicTax / Bitcoin.
                        </li>
                        <li>
                          Fill Formuesverdi per 31.12 with{" "}
                          {formatWholeNok(roundedPortfolioValue)} kr.
                        </li>
                        <li>
                          Fill Antall with{" "}
                          {formatBtcForNorwegianInput(
                            result.totals.remainingBtcAtYearEnd,
                          )}
                          .
                        </li>
                        <li>
                          Fill Inntekt with{" "}
                          {formatWholeNok(roundedMiningIncome)} kr.
                        </li>
                        <li>
                          Fill Gevinst og tap with Samlet gevinst{" "}
                          {formatWholeNok(totalGain)} kr and Samlet tap{" "}
                          {formatWholeNok(totalLoss)} kr.
                        </li>
                      </ol>
                    </section>
                  );
                })()}

                {result.warnings.length > 0 && (
                  <details
                    className="warnings-panel"
                    open={isWarningPanelOpen}
                    onToggle={(event) => {
                      setIsWarningPanelOpen(event.currentTarget.open);
                    }}
                  >
                    <summary>Parser warnings ({counts.all})</summary>

                    <div
                      className="warnings-filters"
                      role="tablist"
                      aria-label="Warning categories"
                    >
                      {warningTabs.map((tab) => {
                        const count = counts[tab];
                        const active = warningFilter === tab;

                        return (
                          <button
                            key={tab}
                            type="button"
                            className={
                              active ? "warning-pill active" : "warning-pill"
                            }
                            onClick={() => setWarningFilter(tab)}
                            aria-pressed={active}
                          >
                            {categoryLabel(tab)} ({count})
                          </button>
                        );
                      })}
                    </div>

                    {visibleWarnings.length > 0 ? (
                      <ul className="warnings-list">
                        {visibleWarnings.map((warning, index) => (
                          <li key={`${warning.message}-${index}`}>
                            <strong>[{categoryLabel(warning.category)}]</strong>{" "}
                            {warning.message}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="warnings-empty">
                        No warnings in this category.
                      </p>
                    )}
                  </details>
                )}
                <p style={{ marginBottom: 8 }}>Skatteetaten export</p>
                <div className="inline" style={{ marginBottom: 12 }}>
                  <button
                    type="button"
                    onClick={() =>
                      downloadText(
                        JSON.stringify(result.skatteetaten.json, null, 2),
                        `skatteetaten-${result.taxYear}.json`,
                        "application/json",
                      )
                    }
                  >
                    Download JSON
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadText(
                        result.skatteetaten.csv,
                        `skatteetaten-${result.taxYear}.csv`,
                        "text/csv;charset=utf-8",
                      )
                    }
                  >
                    Download CSV
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadText(
                        result.skatteetaten.auditJournalCsv,
                        `audit-journal-${result.taxYear}.csv`,
                        "text/csv;charset=utf-8",
                      )
                    }
                  >
                    Download audit journal CSV
                  </button>
                </div>
                <pre>{JSON.stringify(result, null, 2)}</pre>
              </>
            );
          })()}
        </section>
      )}
    </main>
  );
}

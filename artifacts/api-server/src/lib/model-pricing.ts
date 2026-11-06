// Static USD-per-1M-token pricing used to *estimate* AI spend for the
// admin token-usage dashboard. This is NOT the source of truth for actual
// billing — it's a best-effort estimate that must be updated by hand
// whenever OpenAI changes pricing for a model this app uses. Matched by
// substring against the model string configured via OPENAI_MODEL /
// OPENAI_MODEL_FAST_INTRADAY (see lib/openai.ts), so date-suffixed model
// names (e.g. "gpt-4o-2024-08-06") still match their base tier.
const MODEL_PRICING_USD_PER_1M: Array<{
  match: string;
  prompt: number;
  completion: number;
}> = [
  { match: "gpt-4o-mini", prompt: 0.15, completion: 0.6 },
  { match: "gpt-4o", prompt: 2.5, completion: 10 },
];

// Used when the configured model doesn't match any known tier above, so
// cost estimation never silently returns 0 for an unrecognized model.
const FALLBACK_PRICING = { prompt: 2.5, completion: 10 };

function ratesForModel(model: string): { prompt: number; completion: number } {
  const lower = model.toLowerCase();
  const hit = MODEL_PRICING_USD_PER_1M.find((entry) => lower.includes(entry.match));
  return hit ?? FALLBACK_PRICING;
}

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rates = ratesForModel(model);
  const cost =
    (promptTokens / 1_000_000) * rates.prompt +
    (completionTokens / 1_000_000) * rates.completion;
  // Match the schema's numeric(10, 6) precision.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

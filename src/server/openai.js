/**
 * Pure conversion helpers from Qoder client results to OpenAI-compatible
 * response shapes. No network behavior — independently unit-testable.
 */

/**
 * Convert a `client.listModels()` catalog to the OpenAI model-list shape.
 * Model IDs remain unprefixed (chat accepts both "auto" and "qoder/auto").
 */
export function toOpenAiModelList(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "qoder",
    })),
  };
}

/**
 * Convert `client.getUsage()` to the legacy Dashboard Billing subscription
 * shape used by new-api. The `_usd` field names are required by the legacy
 * compatibility contract — the values are Qoder CREDITS, not US dollars.
 * All three limit fields equal usage.user.total.
 */
export function toBillingSubscription(usage) {
  const total = Number(usage?.user?.total) || 0;
  return {
    object: "billing_subscription",
    has_payment_method: true,
    soft_limit_usd: total,
    hard_limit_usd: total,
    system_hard_limit_usd: total,
    access_until: 0,
  };
}

/**
 * Convert `client.getUsage()` to the legacy Dashboard Billing usage shape.
 * new-api divides total_usage by 100 to render a "balance", so usage is
 * multiplied back by 100 here: total_usage = round(usage.user.used × 100).
 * Date parameters are accepted by callers for compatibility but Qoder only
 * provides current quota-cycle totals, not historical ranges.
 */
export function toBillingUsage(usage) {
  const used = Number(usage?.user?.used) || 0;
  return {
    object: "list",
    total_usage: Math.round(used * 100),
  };
}

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
      dmodel: typeof m.dmodel === "string" ? m.dmodel : "",
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
 * Return the current Qoder user usage in the legacy Dashboard Billing shape.
 * The value remains in Qoder credits and is not multiplied or rounded.
 * Date parameters are accepted by callers for compatibility but Qoder only
 * provides current quota-cycle totals, not historical ranges.
 */
export function toBillingUsage(usage) {
  const used = Number(usage?.user?.used) || 0;
  return {
    object: "list",
    total_usage: used,
  };
}

/**
 * Return the user's currently available Qoder credits. Both operands remain in
 * their original credit unit; the result is not multiplied or rounded.
 */
export function toCreditGrants(usage) {
  const total = Number(usage?.user?.total) || 0;
  const used = Number(usage?.user?.used) || 0;
  return {
    object: "credit_summary",
    total_available: total - used,
  };
}

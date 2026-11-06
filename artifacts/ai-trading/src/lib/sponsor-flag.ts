/**
 * Master toggle for SOLID PRIME / PT Solid Gold Berjangka sponsorship UI.
 *
 * Currently `false` because the legal sponsorship agreement has not
 * been signed yet, so every sponsor-branded surface (splash footer,
 * landing CTA, dashboard live banner, profile demo-account card,
 * footer attribution, legal disclosure paragraphs, admin sponsor
 * metrics, etc.) is hidden across the app.
 *
 * Flip this to `true` to re-enable all sponsor surfaces in one place
 * once the agreement is signed — the UI is left intact in the codebase
 * and gated on this single flag, so no re-implementation is needed.
 */
export const SHOW_SPONSOR = false;

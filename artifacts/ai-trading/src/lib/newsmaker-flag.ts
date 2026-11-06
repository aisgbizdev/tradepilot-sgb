/**
 * Master toggle for Newsmaker.id branding / data attribution UI.
 *
 * Currently `false` because the partnership / data-attribution agreement
 * with Newsmaker.id has not been signed yet, so every Newsmaker-branded
 * surface is hidden across the app:
 *
 *   - "Source: Newsmaker.id" link on the news widget
 *   - "Source: Newsmaker.id" link on the calendar widget
 *   - "Source: Newsmaker.id" link on the technical indicators panel
 *   - "Source: Newsmaker (fallback)" label on the live price ticker
 *   - "Powered by newsmaker.id" footer link on the legal pages
 *   - "News data via newsmaker.id" footer paragraph on splash, layout,
 *     and landing pages
 *   - "operated by Newsmaker.id" mention in the Privacy Policy and
 *     Terms of Service intro paragraphs
 *   - "Newsmaker.id" mention in the Terms indemnification clause
 *   - support@newsmaker.id contact email in the legal documents
 *     (replaced with support@tradepilot.id while hidden)
 *
 * Flip this to `true` to re-enable all Newsmaker-branded surfaces in
 * one place once the agreement is signed — the UI is left intact in
 * the codebase and gated on this single flag, so no re-implementation
 * is needed.
 */
export const SHOW_NEWSMAKER = false;

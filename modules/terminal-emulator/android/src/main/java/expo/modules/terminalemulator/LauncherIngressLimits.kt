package expo.modules.terminalemulator

/**
 * The launcher ingress limits (fact sheet §1.1, §5, §6.2, D3). Initial values
 * are the sheet's recommendations; they are confirmed in the integration check
 * with the launcher (D3) and changed only here (plus the TS mirror in
 * lib/launcher-ingress.ts, kept in step by __tests__/launcher-ingress-core.test.ts).
 */
object LauncherIngressLimits {
    /** instruction_text, counted in Unicode code points (not UTF-16 units; §8 R3). */
    const val MAX_TEXT_CODE_POINTS = 4000
    /** correlation_ref, code points; its characters are also restricted (§8 R5). */
    const val MAX_CORRELATION_CODE_POINTS = 256
    /** Undecided submissions (pending approval) per launcher principal before BUSY (MAX_PENDING_APPROVALS). */
    const val MAX_PENDING = 8
    /** A pending submission not decided within this becomes `expired`. */
    const val APPROVAL_WINDOW_MS = 10L * 60L * 1000L
    /** A repeated submission_nonce inside this returns the existing submission (requestId window). */
    const val NONCE_WINDOW_MS = 10L * 60L * 1000L

    /** Stream feed v1 (fact sheet §6.2, R6): inline in one MCP request, under the 64 KiB request cap. */
    const val MAX_FEED_BYTES = 48 * 1024

    // Rate brake (D1): faster than a person composes → tainted (never refused).
    /** Two submissions closer than this. */
    const val RATE_MIN_INTERVAL_MS = 3_000L
    /** More than this many in [RATE_WINDOW_MS] (this one included). */
    const val RATE_MAX_IN_WINDOW = 6
    const val RATE_WINDOW_MS = 60_000L
    /** Code points per second since the previous submission. */
    const val RATE_MAX_CODE_POINTS_PER_SECOND = 20

    // The exported Provider can be called by any installed app. Audit lines
    // for callers that do NOT verify are capped so such an app cannot grow
    // the audit file without bound; the answer (VERIFY_FAILED) is unchanged.
    /** Unverified-caller audit lines per [UNVERIFIED_AUDIT_WINDOW_MS] (both methods together). */
    const val UNVERIFIED_AUDIT_MAX_IN_WINDOW = 30
    const val UNVERIFIED_AUDIT_WINDOW_MS = 60_000L
}

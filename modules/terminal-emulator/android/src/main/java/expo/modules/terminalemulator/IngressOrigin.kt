package expo.modules.terminalemulator

/**
 * The one table that says what each verified ingress origin means for taint
 * (fact sheet §4, A4; D1 decided 2026-11-25). Every place that needs to know
 * whether a typed ingress request is tainted reads [taintFor]; nothing else
 * branches on an origin name. Mirrored by lib/ingress-origin.ts
 * (__tests__/ingress-origin-parity.test.ts keeps the two in step).
 *
 * Rule (D1): taint follows who AUTHORED the content, not who authenticated the
 * channel. Every origin is tainted by default. An origin may name ops whose
 * typed schema carries only text a person composed and sent by an explicit
 * act; those, and only those, can be exempted — and only when the owner turned
 * the exemption on in Settings for the exact caller certificate set
 * ([Facts.exemptionBound]), the request carries nothing but the schema's
 * fields, the schema version is the one the grant was made for, and the rate
 * is human ([Facts.humanRate]). Anything unknown is tainted (fail closed).
 *
 * MCP can never be exempt: the caller is a program that decides its inputs.
 * The exemption is ingress-level only — a run that later reads external input
 * is tainted from then on (that is the runtime's existing, monotonic rule).
 */
object IngressOrigin {
    const val MCP = "mcp"
    const val LAUNCHER = "launcher"

    /** A typed schema whose content fields a person types (D1 condition 2). */
    data class ExemptSchema(
        val op: String,
        val schemaVersion: Int,
        /** The only content field. */
        val contentFields: Set<String>,
        /** Transport metadata the schema allows: never shown to a model, never executed. */
        val metadataFields: Set<String>,
    ) {
        val allFields: Set<String> get() = contentFields + metadataFields
    }

    data class Row(val origin: String, val taintedByDefault: Boolean, val exemptSchemas: List<ExemptSchema>)

    /**
     * THE table. Changing an origin's taint is a change to its row here (and
     * the TS mirror), nowhere else.
     */
    val TABLE: List<Row> = listOf(
        Row(MCP, taintedByDefault = true, exemptSchemas = emptyList()),
        Row(
            LAUNCHER,
            taintedByDefault = true,
            exemptSchemas = listOf(
                ExemptSchema(
                    op = "submit_instruction",
                    schemaVersion = 1,
                    contentFields = setOf("instruction_text"),
                    metadataFields = setOf("correlation_ref", "submission_nonce"),
                ),
            ),
        ),
    )

    fun row(origin: String?): Row? = TABLE.firstOrNull { it.origin == origin }

    fun isKnown(origin: String?): Boolean = row(origin) != null

    /** The exemptable schema for (origin, op), or null. */
    fun exemptSchema(origin: String?, op: String?): ExemptSchema? = row(origin)?.exemptSchemas?.firstOrNull { it.op == op }

    /** The facts [taintFor] needs. All default to the tainted side. */
    data class Facts(
        val origin: String?,
        val op: String?,
        val schemaVersion: Int,
        /** Every key the request carried (unknown keys included). */
        val fields: Set<String>,
        /** The owner's exemption grant exists and is bound to the CURRENT caller certificate set and this op / schema version. */
        val exemptionBound: Boolean = false,
        /** The submission rate is one a person could type at ([LauncherIngressCore.rateBrake] did not trip). */
        val humanRate: Boolean = false,
    )

    /** Why a request is tainted (audit only; never shown to the caller). */
    enum class Why { UNKNOWN_ORIGIN, DEFAULT, NO_SCHEMA, NOT_GRANTED, SCHEMA_VERSION, EXTRA_FIELD, NO_CONTENT, RATE, EXEMPT }

    data class Verdict(val tainted: Boolean, val exemptApplied: Boolean, val why: Why)

    /** The single origin → taint decision. Never throws. */
    fun taintFor(f: Facts): Verdict {
        val row = row(f.origin) ?: return Verdict(true, false, Why.UNKNOWN_ORIGIN)
        if (!row.taintedByDefault) return Verdict(false, false, Why.DEFAULT)
        val schema = row.exemptSchemas.firstOrNull { it.op == f.op } ?: return Verdict(true, false, Why.NO_SCHEMA)
        if (!f.exemptionBound) return Verdict(true, false, Why.NOT_GRANTED)
        if (f.schemaVersion != schema.schemaVersion) return Verdict(true, false, Why.SCHEMA_VERSION)
        if (!schema.allFields.containsAll(f.fields)) return Verdict(true, false, Why.EXTRA_FIELD)
        if (!f.fields.containsAll(schema.contentFields)) return Verdict(true, false, Why.NO_CONTENT)
        if (!f.humanRate) return Verdict(true, false, Why.RATE)
        return Verdict(false, true, Why.EXEMPT)
    }
}

package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** IngressDecision (shared stage order) and IngressOrigin (origin → taint table). */
class IngressDecisionTest {
    private val id = "0123456789abcdef0123456789abcdef"

    // ── Stage order ────────────────────────────────────────────────────────

    @Test
    fun everyOpListsOnlyStagesInTheOrder() {
        for ((_, stages) in IngressDecision.STAGES) assertTrue(IngressDecision.ORDER.containsAll(stages))
        assertEquals(IngressDecision.Stage.values().toList(), IngressDecision.ORDER)
    }

    @Test
    fun submitInstructionSkipsTheRunAgentOnlyStagesExplicitly() {
        val submit = IngressDecision.STAGES.getValue(IngressDecision.OP_SUBMIT_INSTRUCTION)
        for (s in listOf(
            IngressDecision.Stage.EPOCH, IngressDecision.Stage.TARGET,
            IngressDecision.Stage.ACTION_CONSENT, IngressDecision.Stage.STEP7,
        )) {
            assertFalse(s.name, s in submit)
        }
        for (s in listOf(
            IngressDecision.Stage.SETTING, IngressDecision.Stage.ARGS, IngressDecision.Stage.STOP_ALL,
            IngressDecision.Stage.TAINT, IngressDecision.Stage.IDEMPOTENT, IngressDecision.Stage.ALWAYS_ALLOW,
            IngressDecision.Stage.APPROVE_ALL,
        )) {
            assertTrue(s.name, s in submit)
        }
    }

    @Test
    fun evaluateRunsInOrderAndStopsAtTheFirstAnswer() {
        val seen = ArrayList<IngressDecision.Stage>()
        val hooks = IngressDecision.STAGES.getValue(IngressDecision.OP_SUBMIT_INSTRUCTION).associateWith { st ->
            { seen.add(st); if (st == IngressDecision.Stage.TAINT) "stop" else null }
        }
        assertEquals("stop", IngressDecision.evaluate(IngressDecision.OP_SUBMIT_INSTRUCTION, hooks))
        assertEquals(
            listOf(IngressDecision.Stage.SETTING, IngressDecision.Stage.ARGS, IngressDecision.Stage.STOP_ALL, IngressDecision.Stage.TAINT),
            seen,
        )
    }

    @Test
    fun evaluateRefusesHooksThatDoNotMatchTheOp() {
        val hooks = mapOf<IngressDecision.Stage, () -> String?>(IngressDecision.Stage.SETTING to { null })
        try {
            IngressDecision.evaluate(IngressDecision.OP_SUBMIT_INSTRUCTION, hooks)
            throw AssertionError("expected IllegalStateException")
        } catch (e: IllegalStateException) {
            // expected
        }
    }

    // ── Principal ──────────────────────────────────────────────────────────

    @Test
    fun mcpPrincipalKeepsItsBareWireFormAndLauncherIsPrefixed() {
        assertEquals(id, IngressDecision.Principal.mcp(id).wire)
        assertEquals("launcher:$id", IngressDecision.Principal(IngressOrigin.LAUNCHER, id).wire)
        assertEquals(IngressDecision.Principal.mcp(id), IngressDecision.Principal.parse(id))
        assertEquals(IngressDecision.Principal(IngressOrigin.LAUNCHER, id), IngressDecision.Principal.parse("launcher:$id"))
        for (bad in listOf(null, "", "mcp:$id", "other:$id", "launcher:", "launcher:${id.uppercase()}", id.dropLast(1))) {
            assertNull(bad.toString(), IngressDecision.Principal.parse(bad))
        }
    }

    // ── Origin → taint (A4, D1) ────────────────────────────────────────────

    private fun launcher(
        fields: Set<String> = setOf("instruction_text"),
        bound: Boolean = true,
        human: Boolean = true,
        version: Int = 1,
        op: String = "submit_instruction",
    ) = IngressOrigin.Facts(IngressOrigin.LAUNCHER, op, version, fields, bound, human)

    @Test
    fun everyOriginIsTaintedByDefault() {
        for (row in IngressOrigin.TABLE) assertTrue(row.origin, row.taintedByDefault)
        assertTrue(IngressOrigin.taintFor(IngressOrigin.Facts(IngressOrigin.MCP, "run_agent", 1, emptySet(), true, true)).tainted)
        assertTrue(IngressOrigin.taintFor(IngressOrigin.Facts("unknown", "submit_instruction", 1, setOf("instruction_text"), true, true)).tainted)
        assertTrue(IngressOrigin.taintFor(IngressOrigin.Facts(null, null, 1, emptySet())).tainted)
    }

    @Test
    fun mcpIsNeverExemptEvenForTheLauncherOp() {
        val v = IngressOrigin.taintFor(IngressOrigin.Facts(IngressOrigin.MCP, "submit_instruction", 1, setOf("instruction_text"), true, true))
        assertTrue(v.tainted)
        assertFalse(v.exemptApplied)
    }

    @Test
    fun launcherIsExemptOnlyWhenEveryConditionHolds() {
        val ok = IngressOrigin.taintFor(launcher(fields = setOf("instruction_text", "correlation_ref", "submission_nonce")))
        assertFalse(ok.tainted)
        assertTrue(ok.exemptApplied)
        assertEquals(IngressOrigin.Why.EXEMPT, ok.why)
        val cases = listOf(
            IngressOrigin.Why.NOT_GRANTED to launcher(bound = false),
            IngressOrigin.Why.RATE to launcher(human = false),
            IngressOrigin.Why.SCHEMA_VERSION to launcher(version = 2),
            IngressOrigin.Why.EXTRA_FIELD to launcher(fields = setOf("instruction_text", "attachment_url")),
            IngressOrigin.Why.EXTRA_FIELD to launcher(fields = setOf("instruction_text", "caller_package")),
            IngressOrigin.Why.NO_CONTENT to launcher(fields = setOf("correlation_ref")),
            IngressOrigin.Why.NO_SCHEMA to launcher(op = "forward_content"),
        )
        for ((why, facts) in cases) {
            val v = IngressOrigin.taintFor(facts)
            assertTrue(why.name, v.tainted)
            assertFalse(why.name, v.exemptApplied)
            assertEquals(why, v.why)
        }
    }
}

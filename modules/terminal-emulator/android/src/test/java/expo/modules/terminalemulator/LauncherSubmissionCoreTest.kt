package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpRunTickets.Submission
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** LauncherSubmissionCore: launcher ingress Phase 2 (C6 decisions, inbox, stale, D2 reader). */
class LauncherSubmissionCoreTest {
    private val lp = "launcher:0123456789abcdef0123456789abcdef"
    private val mcp = "fedcba9876543210fedcba9876543210"
    private val now = 1_763_208_000_000L
    private val secret = "the owner's instruction"

    private fun sub(
        id: String = "ls_" + "1".repeat(32),
        state: String = McpRunTickets.SUB_PENDING,
        acceptedAt: Long = now,
        decidedAt: Long? = null,
        via: String? = null,
        untrusted: Boolean = true,
        consumedAt: Long? = null,
    ) = Submission(
        id = id, principal = lp, state = state, acceptedAt = acceptedAt, decidedAt = decidedAt, nonce = null,
        correlationRef = "task:7", untrusted = untrusted, exemptApplied = false, textSha256 = "a".repeat(64),
        textCodePoints = 23, certDigest = "b".repeat(64), schemaVersion = 1, approvedVia = via, ruleId = null, consumedAt = consumedAt,
    )

    private fun entry(enabled: Boolean = true, pins: List<String> = listOf("b".repeat(64))) =
        TrustedCallerStore.Entry(IngressOrigin.LAUNCHER, "com.example.launcher", pins, enabled, null, 0L)

    @Test
    fun staleIsDerivedFromTheApprovalTimeAndNeverStored() {
        val approved = sub(state = McpRunTickets.SUB_APPROVED, decidedAt = now, via = "user")
        assertEquals(McpRunTickets.SUB_APPROVED, LauncherSubmissionCore.viewState(approved, now + LauncherIngressLimits.STALE_AFTER_MS))
        assertEquals(LauncherSubmissionCore.STATE_STALE, LauncherSubmissionCore.viewState(approved, now + LauncherIngressLimits.STALE_AFTER_MS + 1))
        assertFalse(LauncherSubmissionCore.STATE_STALE in McpRunTickets.SUBMISSION_STATES)
        assertEquals(McpRunTickets.SUB_EXPIRED, LauncherSubmissionCore.viewState(sub(), now + LauncherIngressLimits.APPROVAL_WINDOW_MS + 1))
    }

    @Test
    fun decisionsUseOnlyTheExistingKinds() {
        assertEquals(LauncherSubmissionCore.UserDecision.DENY, LauncherSubmissionCore.parseUserDecision("deny"))
        assertEquals(LauncherSubmissionCore.UserDecision.ONCE, LauncherSubmissionCore.parseUserDecision("once"))
        assertEquals(LauncherSubmissionCore.UserDecision.ALWAYS, LauncherSubmissionCore.parseUserDecision("always"))
        for (bad in listOf("approve", "allow", "dismiss", "", null)) assertNull(LauncherSubmissionCore.parseUserDecision(bad))
    }

    @Test
    fun aPendingOneIsDecidedOnceAndExpiredStaysExpired() {
        val p = sub()
        val once = LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.ONCE, now + 1, halted = false, registrationValid = true)
        once as LauncherSubmissionCore.DecisionPlan.Write
        assertEquals(McpRunTickets.SUB_APPROVED, once.next.state)
        assertEquals("user", once.next.approvedVia)
        assertEquals("launcher_submit_approved", once.auditKind)
        assertFalse(once.addRule)
        val always = LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.ALWAYS, now + 1, false, true)
        assertTrue((always as LauncherSubmissionCore.DecisionPlan.Write).addRule)
        val deny = LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.DENY, now + 1, false, true)
        deny as LauncherSubmissionCore.DecisionPlan.Write
        assertEquals(McpRunTickets.SUB_DENIED_BY_USER, deny.next.state)
        assertEquals("launcher_submit_user_denied", deny.auditKind)
        assertTrue(deny.dropText)
        // Past the window: expired, nothing can be decided (P2-A4).
        val late = now + LauncherIngressLimits.APPROVAL_WINDOW_MS + 1
        assertEquals(LauncherSubmissionCore.DecisionPlan.Refuse("not_pending"),
            LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.ONCE, late, false, true))
        assertEquals(LauncherSubmissionCore.DecisionPlan.Refuse("not_pending"),
            LauncherSubmissionCore.planUserDecision(once.next, LauncherSubmissionCore.UserDecision.DENY, now + 2, false, true))
        assertEquals(LauncherSubmissionCore.DecisionPlan.Refuse("not_found"),
            LauncherSubmissionCore.planUserDecision(null, LauncherSubmissionCore.UserDecision.DENY, now, false, true))
    }

    @Test
    fun stopAllAndAChangedRegistrationBlockApprovalButNotDenial() {
        val p = sub()
        assertEquals(LauncherSubmissionCore.DecisionPlan.Refuse("halted"),
            LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.ONCE, now, halted = true, registrationValid = true))
        assertEquals(LauncherSubmissionCore.DecisionPlan.Refuse("registration_changed"),
            LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.ALWAYS, now, halted = false, registrationValid = false))
        assertTrue(LauncherSubmissionCore.planUserDecision(p, LauncherSubmissionCore.UserDecision.DENY, now, true, false) is LauncherSubmissionCore.DecisionPlan.Write)
        assertTrue(LauncherSubmissionCore.registrationValid(entry(), p))
        assertFalse(LauncherSubmissionCore.registrationValid(entry(enabled = false), p))
        assertFalse(LauncherSubmissionCore.registrationValid(entry(pins = listOf("c".repeat(64))), p))
        assertFalse(LauncherSubmissionCore.registrationValid(null, p))
    }

    @Test
    fun theReaderGetsTheTextOnlyForApproved() {
        val approved = sub(state = McpRunTickets.SUB_APPROVED, decidedAt = now, via = "user")
        val a = LauncherSubmissionCore.readerItem(approved, now + 1, secret)
        assertEquals(secret, a.getString("instruction_text"))
        assertEquals("task:7", a.getString("correlation_ref"))
        assertEquals("approved", a.getString("state"))
        for (s in listOf(
            sub(),
            sub(state = McpRunTickets.SUB_DENIED_BY_USER, decidedAt = now),
            sub(state = McpRunTickets.SUB_EXPIRED, decidedAt = now),
            sub(state = McpRunTickets.SUB_CONSUMED, decidedAt = now, via = "user", consumedAt = now + 5),
        )) {
            val o = LauncherSubmissionCore.readerItem(s, now + 10, secret)
            assertFalse(s.state, o.has("instruction_text"))
            assertFalse(s.state, o.has("correlation_ref"))
            assertTrue(s.state, o.has("reason"))
        }
        // Stale: no text either.
        val stale = LauncherSubmissionCore.readerItem(approved, now + LauncherIngressLimits.STALE_AFTER_MS + 1, secret)
        assertEquals("stale", stale.getString("state"))
        assertFalse(stale.has("instruction_text"))
        // A list never carries text.
        val list = LauncherSubmissionCore.listData(listOf(approved, sub(id = "ls_" + "2".repeat(32))), emptyList(), now + 1, 50)
        assertFalse(list.toString().contains(secret))
        assertEquals(2, list.getInt("count"))
    }

    @Test
    fun readerArgsAreStrict() {
        fun args(s: String) = JSONObject(s)
        assertTrue(LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_GET, args("""{"submissionId":"ls_${"a".repeat(32)}"}""")) is LauncherSubmissionCore.ReaderArgs.Get)
        assertTrue(LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_GET, args("""{"submissionId":"mr_${"a".repeat(32)}"}""")) is McpTypedOpDecision.Refusal)
        assertTrue(LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_CONSUME, args("""{"submissionId":"ls_${"a".repeat(32)}","x":1}""")) is McpTypedOpDecision.Refusal)
        assertEquals(LauncherSubmissionCore.ReaderArgs.ListAll(LauncherIngressLimits.READER_LIST_DEFAULT), LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_LIST, args("{}")))
        assertEquals(LauncherSubmissionCore.ReaderArgs.ListAll(5), LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_LIST, args("""{"limit":5}""")))
        assertTrue(LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_LIST, args("""{"limit":51}""")) is McpTypedOpDecision.Refusal)
        assertTrue(LauncherSubmissionCore.validateReaderArgs(LauncherSubmissionCore.OP_LIST, args("""{"limit":0}""")) is McpTypedOpDecision.Refusal)
    }

    private class Steps(var on: Boolean = true, var epoch: Boolean = true, var halted: Boolean = false) : LauncherSubmissionCore.ReaderSteps {
        val asked = ArrayList<String>()
        override fun typedOpsOn(): Boolean { asked.add("setting"); return on }
        override fun epochCurrent(): Boolean { asked.add("epoch"); return epoch }
        override fun halted(): Boolean { asked.add("halted"); return halted }
    }

    private fun req(tool: String, args: String) = McpTypedOpDecision.Request("c1", tool, JSONObject(args), mcp, now)

    @Test
    fun readerDecisionOrderIsSettingArgsEpochStopAll() {
        val id = """{"submissionId":"ls_${"a".repeat(32)}"}"""
        assertEquals("disabled", (LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_GET, id), Steps(on = false)) as LauncherSubmissionCore.ReaderOutcome.Refuse).refusal.code)
        assertEquals("invalid_params", (LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_GET, "{}"), Steps()) as LauncherSubmissionCore.ReaderOutcome.Refuse).refusal.code)
        assertEquals("revoked", (LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_CONSUME, id), Steps(epoch = false)) as LauncherSubmissionCore.ReaderOutcome.Refuse).refusal.code)
        assertEquals("halted", (LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_LIST, "{}"), Steps(halted = true)) as LauncherSubmissionCore.ReaderOutcome.Refuse).refusal.code)
        val s = Steps()
        assertTrue(LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_GET, id), s) is LauncherSubmissionCore.ReaderOutcome.Proceed)
        assertEquals(listOf("setting", "epoch", "halted"), s.asked)
        assertTrue(LauncherSubmissionCore.decideReader(req("run_agent", "{}"), Steps()) is LauncherSubmissionCore.ReaderOutcome.Refuse)
    }

    @Test
    fun readerAuditLinesAreClosedAndCarryNoText() {
        val id = "ls_" + "a".repeat(32)
        val get = JSONObject(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_get", mcp, id, "ok_text", null)!!)
        assertEquals("launcher_submission_get", get.getString("event"))
        assertEquals("mcp", get.getString("origin"))
        assertEquals(setOf("ts", "kind", "event", "origin", "principal", "submission_id", "code"), get.keys().asSequence().toSet())
        assertNotNull(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_list", mcp, null, "ok", 3))
        assertNull(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_list", mcp, id, "ok", 3))
        assertNull(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_get", mcp, id, "ok", 3))
        assertNull(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_read", mcp, id, "ok", null))
        assertNull(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_get", lp, id, "ok", null))
        assertNull(IngressAuditWriter.buildSubmissionReaderLine(now, "launcher_submission_get", mcp, id, "Has Text", null))
        val expired = IngressAuditWriter.buildLauncherLine(now, LauncherSubmissionCore.recordLine("launcher_submit_expired", "expired", sub()))!!
        assertFalse(expired.contains(secret))
        assertTrue(expired.contains("\"textSha256\""))
    }

    private fun denial(i: Int, at: Long, reason: String = "STOP_ALL_ACTIVE", code: String = "halted") = McpRunTickets.Denial(
        id = "ls_" + "%032x".format(1000 + i), principal = lp, at = at, code = code, reason = reason, correlationRef = "task:7", ref = null,
    )

    @Test
    fun inboxCapsTheCombinedPopulationAtFiftyAndNeverShowsText() {
        val old = sub(id = "ls_" + "e".repeat(32), state = McpRunTickets.SUB_DENIED_BY_USER, acceptedAt = now - LauncherIngressLimits.INBOX_MAX_AGE_MS - 1, decidedAt = now)
        val many = (0 until 40).map { i ->
            sub(id = "ls_" + "%032x".format(i), state = McpRunTickets.SUB_APPROVED, acceptedAt = now - 5_000L * (i + 1), decidedAt = now - 5_000L * (i + 1), via = "user")
        }
        val denials = (0 until 30).map { i -> denial(i, now - 3_000L * (i + 1)) }
        val pendings = (0 until LauncherIngressLimits.MAX_PENDING).map { i ->
            sub(id = "ls_" + "%032x".format(500 + i), acceptedAt = now - 500_000L + i)
        }
        val o = JSONObject(LauncherSubmissionCore.inboxJson(many + old + pendings, denials, now, halted = false))
        val items = o.getJSONArray("items")
        // The shorter of the newest 50 and 7 days, over records AND denials together.
        assertEquals(LauncherIngressLimits.INBOX_MAX_RECORDS, items.length())
        // Every pending (decidable) one survives the cap even though they are the oldest rows here.
        val states = (0 until items.length()).map { items.getJSONObject(it).getString("state") }
        assertEquals(LauncherIngressLimits.MAX_PENDING, states.count { it == "pending_approval" })
        assertTrue(states.contains("denied"))
        assertFalse(o.toString().contains(old.id))
        assertFalse(o.toString().contains("instruction"))
        // A denial row carries its reason, never text.
        val d = (0 until items.length()).map { items.getJSONObject(it) }.first { it.getString("state") == "denied" }
        assertEquals("STOP_ALL_ACTIVE", d.getString("reason"))
        assertFalse(d.has("text"))
    }

    @Test
    fun capInboxNeverExceedsFiftyEvenWithManyPending() {
        assertTrue(LauncherIngressLimits.MAX_PENDING <= LauncherIngressLimits.INBOX_MAX_RECORDS)
        val rows = (0 until 80).map { i -> LauncherSubmissionCore.InboxRow(now - i, "k$i", i % 2 == 0, JSONObject()) }
        val kept = LauncherSubmissionCore.capInbox(rows, now)
        assertEquals(LauncherIngressLimits.INBOX_MAX_RECORDS, kept.size)
        // 40 pending all kept, then the newest 10 others.
        assertEquals(40, kept.count { it.pending })
    }

    @Test
    fun pruneCountsDenialsAndKeepsPendingWithinTheCap() {
        val subs = (0 until 30).map { i ->
            sub(id = "ls_" + "%032x".format(i), state = McpRunTickets.SUB_APPROVED, acceptedAt = now - 60_000L * (i + 1), decidedAt = now, via = "user")
        } + (0 until LauncherIngressLimits.MAX_PENDING).map { i -> sub(id = "ls_" + "%032x".format(500 + i), acceptedAt = now - 100_000L + i) }
        val denials = (0 until 30).map { i -> denial(i, now - 1000L * (i + 1)) }
        val drop = McpRunTickets.submissionsToPrune(subs, denials, now)
        // 68 + the incoming one = 69 → 19 dropped, none pending.
        assertEquals(30 + LauncherIngressLimits.MAX_PENDING + 30 + 1 - LauncherIngressLimits.INBOX_MAX_RECORDS, drop.size)
        assertTrue(drop.none { it.startsWith("ls_") && it.substring(3).toLong(16) in 500L..507L })
        val left = subs.size + denials.size - drop.size + 1
        assertTrue(left <= LauncherIngressLimits.INBOX_MAX_RECORDS)
        // Older than 7 days goes regardless of the count.
        val old = denial(99, now - LauncherIngressLimits.INBOX_MAX_AGE_MS - 1)
        assertTrue(old.id in McpRunTickets.submissionsToPrune(emptyList(), listOf(old), now))
    }

    @Test
    fun denialRecordsAreClosedTextFreeAndNeverSubmissions() {
        val d = denial(1, now)
        val json = McpRunTickets.encodeDenial(d)
        assertEquals(d, McpRunTickets.decodeDenial(json))
        assertNull(McpRunTickets.decodeSubmission(json))
        assertNull(McpRunTickets.decodeDenial(McpRunTickets.encodeSubmission(sub())))
        assertNull(McpRunTickets.decodeDenial(JSONObject(json).put("text", "x").toString()))
        assertFalse(McpRunTickets.isValidDenial(d.copy(reason = "VERIFY_FAILED")))
        assertFalse(McpRunTickets.isValidDenial(d.copy(principal = mcp)))
        assertFalse(McpRunTickets.isValidDenial(d.copy(code = "Bad Code")))
        val item = LauncherSubmissionCore.deniedReaderItem(d)
        assertEquals("denied", item.getString("state"))
        assertFalse(item.has("instruction_text"))
        // The reader's list shows it as denied, no text.
        val list = LauncherSubmissionCore.listData(emptyList(), listOf(d), now, 10)
        assertEquals("denied", list.getJSONArray("submissions").getJSONObject(0).getString("state"))
    }

    @Test
    fun readerRefusalsKeepTheValidatedIdForTheAuditLine() {
        val id = "ls_" + "a".repeat(32)
        val halted = LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_CONSUME, """{"submissionId":"$id"}"""), Steps(halted = true))
        assertEquals(id, (halted as LauncherSubmissionCore.ReaderOutcome.Refuse).id)
        val revoked = LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_GET, """{"submissionId":"$id"}"""), Steps(epoch = false))
        assertEquals(id, (revoked as LauncherSubmissionCore.ReaderOutcome.Refuse).id)
        val badArgs = LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_GET, """{"submissionId":"nope"}"""), Steps())
        assertNull((badArgs as LauncherSubmissionCore.ReaderOutcome.Refuse).id)
        val disabled = LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_GET, """{"submissionId":"$id"}"""), Steps(on = false))
        assertNull((disabled as LauncherSubmissionCore.ReaderOutcome.Refuse).id)
        val list = LauncherSubmissionCore.decideReader(req(LauncherSubmissionCore.OP_LIST, "{}"), Steps(halted = true))
        assertNull((list as LauncherSubmissionCore.ReaderOutcome.Refuse).id)
    }
}

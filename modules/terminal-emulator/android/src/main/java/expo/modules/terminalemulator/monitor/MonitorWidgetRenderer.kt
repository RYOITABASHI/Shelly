package expo.modules.terminalemulator.monitor

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.widget.RemoteViews
import expo.modules.terminalemulator.R
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.CamState
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.Cost
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.Tone
import java.util.Locale

/**
 * Model -> RemoteViews for both MONITOR layouts. Only ids that exist in the
 * chosen layout are touched (a missing id makes the launcher show "Problem
 * loading widget"): the 4x2 layout has no header, pill or camera footer.
 *
 * Deep links (consumed by app/_layout.tsx -> lib/monitor-widget-link.ts):
 *   shelly://monitor?agentId=<id>            whole widget: MONITOR pane, LIVE on that agent
 *   shelly://monitor?agentId=<id>&step=<n>   camera: MONITOR single view on that channel
 */
object MonitorWidgetRenderer {
    private data class CamIds(
        val root: Int,
        val img: Int,
        val noSignal: Int,
        val rec: Int,
        val recStatic: Int,
        val bang: Int,
        val ch: Int,
        val pill: Int?,
        val bar: Int?,
        val kind: Int?,
        val name: Int?,
        val cost: Int?
    )

    private val FULL_CAMS = listOf(
        CamIds(R.id.monitor_cam_1, R.id.monitor_cam_1_img, R.id.monitor_cam_1_nosignal, R.id.monitor_cam_1_rec,
            R.id.monitor_cam_1_rec_static, R.id.monitor_cam_1_bang, R.id.monitor_cam_1_ch, R.id.monitor_cam_1_pill,
            R.id.monitor_cam_1_bar, R.id.monitor_cam_1_kind, R.id.monitor_cam_1_name, R.id.monitor_cam_1_cost),
        CamIds(R.id.monitor_cam_2, R.id.monitor_cam_2_img, R.id.monitor_cam_2_nosignal, R.id.monitor_cam_2_rec,
            R.id.monitor_cam_2_rec_static, R.id.monitor_cam_2_bang, R.id.monitor_cam_2_ch, R.id.monitor_cam_2_pill,
            R.id.monitor_cam_2_bar, R.id.monitor_cam_2_kind, R.id.monitor_cam_2_name, R.id.monitor_cam_2_cost),
        CamIds(R.id.monitor_cam_3, R.id.monitor_cam_3_img, R.id.monitor_cam_3_nosignal, R.id.monitor_cam_3_rec,
            R.id.monitor_cam_3_rec_static, R.id.monitor_cam_3_bang, R.id.monitor_cam_3_ch, R.id.monitor_cam_3_pill,
            R.id.monitor_cam_3_bar, R.id.monitor_cam_3_kind, R.id.monitor_cam_3_name, R.id.monitor_cam_3_cost),
        CamIds(R.id.monitor_cam_4, R.id.monitor_cam_4_img, R.id.monitor_cam_4_nosignal, R.id.monitor_cam_4_rec,
            R.id.monitor_cam_4_rec_static, R.id.monitor_cam_4_bang, R.id.monitor_cam_4_ch, R.id.monitor_cam_4_pill,
            R.id.monitor_cam_4_bar, R.id.monitor_cam_4_kind, R.id.monitor_cam_4_name, R.id.monitor_cam_4_cost)
    )

    /** Per-camera REC flipper (different intervals so feeds do not blink in lock-step). */
    private val REC_LAYOUTS = intArrayOf(
        R.layout.monitor_cam_rec_1, R.layout.monitor_cam_rec_2, R.layout.monitor_cam_rec_3, R.layout.monitor_cam_rec_4
    )

    private val SLIM_CAMS =FULL_CAMS.map { it.copy(pill = null, bar = null, kind = null, name = null, cost = null) }

    /** [operator 1..5][Variant.ordinal: LIVE, DIM, ALERT, FAIL]. */
    private val OPERATORS = arrayOf(
        intArrayOf(R.drawable.monitor_operator_1_live, R.drawable.monitor_operator_1_dim, R.drawable.monitor_operator_1_alert, R.drawable.monitor_operator_1_fail),
        intArrayOf(R.drawable.monitor_operator_2_live, R.drawable.monitor_operator_2_dim, R.drawable.monitor_operator_2_alert, R.drawable.monitor_operator_2_fail),
        intArrayOf(R.drawable.monitor_operator_3_live, R.drawable.monitor_operator_3_dim, R.drawable.monitor_operator_3_alert, R.drawable.monitor_operator_3_fail),
        intArrayOf(R.drawable.monitor_operator_4_live, R.drawable.monitor_operator_4_dim, R.drawable.monitor_operator_4_alert, R.drawable.monitor_operator_4_fail),
        intArrayOf(R.drawable.monitor_operator_5_live, R.drawable.monitor_operator_5_dim, R.drawable.monitor_operator_5_alert, R.drawable.monitor_operator_5_fail)
    )

    private val PHOSPHOR = Color.rgb(0xA8, 0xF0, 0xCF)
    private val OSD = Color.rgb(0xEA, 0xF5, 0xEE)
    private val LABEL = Color.rgb(0xA9, 0xB7, 0xAE)
    private val MUTED = Color.rgb(0x6C, 0x7A, 0x71)
    private val AMBER = Color.rgb(0xFF, 0xB2, 0x1E)
    private val DONE = Color.rgb(0x8F, 0xA6, 0xBD)
    private val FAIL = Color.rgb(0xFF, 0x6B, 0x5E)
    private val K_API = Color.rgb(0x7C, 0xC7, 0xFF)
    private val K_CLI = Color.rgb(0xD4, 0xA8, 0xFF)
    private val K_LOCAL = Color.rgb(0xA8, 0xF0, 0xCF)

    private const val REQ_ROOT = 9300
    private const val REQ_ALERT = 9310
    private const val REQ_SLIM_OFFSET = 50

    fun render(
        context: Context,
        snapshot: MonitorWidgetRepository.Snapshot,
        slim: Boolean,
        appLocale: String?
    ): RemoteViews {
        val res = localized(context, appLocale)
        val japanese = (appLocale ?: context.resources.configuration.locales[0].language) == "ja"
        val views = RemoteViews(context.packageName, if (slim) R.layout.monitor_widget_slim else R.layout.monitor_widget_full)
        val model = snapshot.model
        val reqOffset = if (slim) REQ_SLIM_OFFSET else 0
        val motion = animationsEnabled(context)

        views.setOnClickPendingIntent(R.id.monitor_root, link(context, model?.agentId, null, REQ_ROOT + reqOffset))
        views.setViewVisibility(R.id.monitor_empty, if (model == null) View.VISIBLE else View.GONE)
        if (model == null) views.setTextViewText(R.id.monitor_empty, res.getString(R.string.monitor_widget_empty))

        if (!slim) bindHeader(views, context, res, model, snapshot.agentName, japanese)

        val ids = if (slim) SLIM_CAMS else FULL_CAMS
        ids.forEachIndexed { slot, cam ->
            val camera = model?.cameras?.getOrNull(slot)
            bindCamera(views, context, res, cam, slot, camera, model, japanese, motion, REQ_ROOT + reqOffset + 1 + slot)
        }
        return views
    }

    private fun bindHeader(
        views: RemoteViews,
        context: Context,
        res: Context,
        model: MonitorWidgetModel.Model?,
        agentName: String?,
        japanese: Boolean
    ) {
        val pct = model?.missionPct ?: 0
        val toneColor = model?.let { toneColor(it.tone) } ?: MUTED
        views.setProgressBar(R.id.monitor_bar, 100, pct, false)
        tintProgress(views, R.id.monitor_bar, toneColor)
        views.setTextViewText(R.id.monitor_pct, if (model == null) "--" else "$pct%")
        views.setTextColor(R.id.monitor_pct, toneColor)

        val iteration = model?.iteration
        if (iteration != null) {
            views.setTextViewText(R.id.monitor_iteration, res.getString(R.string.monitor_widget_iteration, iteration))
            views.setViewVisibility(R.id.monitor_iteration, View.VISIBLE)
        } else {
            views.setViewVisibility(R.id.monitor_iteration, View.GONE)
        }

        // Elapsed clock: the launcher's Chronometer ticks while the run is
        // live; otherwise it shows the run's final duration, stopped.
        val now = System.currentTimeMillis()
        val start = model?.runStartMs
        val end = model?.runEndMs ?: now
        val elapsed = if (start == null) 0L else (end - start).coerceAtLeast(0L)
        views.setChronometer(
            R.id.monitor_timer,
            SystemClock.elapsedRealtime() - elapsed,
            res.getString(R.string.monitor_widget_timer_format),
            model?.live == true && start != null
        )

        val approval = model?.approvalChannel
        if (model == null) {
            views.setViewVisibility(R.id.monitor_cost, View.GONE)
            views.setViewVisibility(R.id.monitor_alert, View.GONE)
        } else if (approval != null) {
            views.setTextViewText(R.id.monitor_alert, res.getString(R.string.monitor_widget_alert, approval))
            views.setViewVisibility(R.id.monitor_alert, View.VISIBLE)
            views.setViewVisibility(R.id.monitor_cost, View.GONE)
            views.setOnClickPendingIntent(R.id.monitor_alert, link(context, model.agentId, model.approvalStep, REQ_ALERT))
        } else {
            views.setViewVisibility(R.id.monitor_alert, View.GONE)
            views.setTextViewText(R.id.monitor_cost, costLine(res, model.costLine, agentName, japanese))
            views.setViewVisibility(R.id.monitor_cost, View.VISIBLE)
        }
    }

    private fun costLine(res: Context, c: MonitorWidgetModel.CostLine, agentName: String?, japanese: Boolean): String {
        val parts = mutableListOf<String>()
        agentName?.let { parts += shorten(it, 18) }
        if (c.hasApi) {
            val amount = when {
                c.apiUsd != null -> MonitorWidgetModel.formatMoney(c.apiUsd, japanese)
                c.apiTokens > 0 -> MonitorWidgetModel.formatTokens(c.apiTokens)
                else -> "—"
            }
            parts += res.getString(R.string.monitor_widget_cost_api, amount)
        }
        if (c.hasCli) {
            val plan = res.getString(R.string.monitor_widget_cost_plan)
            val v = if (c.cliTokens > 0) "${MonitorWidgetModel.formatTokens(c.cliTokens)} $plan" else plan
            parts += res.getString(R.string.monitor_widget_cost_cli, v)
        }
        if (c.hasLocal) {
            val zero = MonitorWidgetModel.zeroMoney(japanese)
            val v = if (c.localTokens > 0) "${MonitorWidgetModel.formatTokens(c.localTokens)} $zero" else zero
            parts += res.getString(R.string.monitor_widget_cost_local, v)
        }
        return parts.joinToString(res.getString(R.string.monitor_widget_cost_separator))
    }

    private fun bindCamera(
        views: RemoteViews,
        context: Context,
        res: Context,
        ids: CamIds,
        slot: Int,
        camera: MonitorWidgetModel.Camera?,
        model: MonitorWidgetModel.Model?,
        japanese: Boolean,
        motion: Boolean,
        requestCode: Int
    ) {
        val state = camera?.state ?: CamState.NO_SIGNAL
        val noSignal = state == CamState.NO_SIGNAL
        val channel = camera?.channel ?: MonitorWidgetModel.channel(slot)
        val live = model?.live == true

        views.setTextViewText(ids.ch, channel)
        views.setViewVisibility(ids.noSignal, if (noSignal) View.VISIBLE else View.GONE)
        if (camera != null && !noSignal) {
            val op = camera.operator.coerceIn(1, OPERATORS.size)
            views.setImageViewResource(ids.img, OPERATORS[op - 1][camera.variant.ordinal])
        }
        val running = live && state == CamState.RUNNING
        val asking = live && state == CamState.APPROVAL
        // The flippers (REC blink + noise frame, the approval "!") exist in
        // the view tree only while this camera needs them: a ViewFlipper keeps
        // flipping whenever its window is visible, even when the view itself
        // is GONE, so a hidden one would still cost the launcher redraws.
        // With animations off, a steady REC instead.
        views.removeAllViews(ids.rec)
        if (running && motion) views.addView(ids.rec, RemoteViews(context.packageName, REC_LAYOUTS[slot % REC_LAYOUTS.size]))
        views.setViewVisibility(ids.recStatic, if (asking || (running && !motion)) View.VISIBLE else View.GONE)
        views.removeAllViews(ids.bang)
        if (asking) {
            views.addView(
                ids.bang,
                RemoteViews(context.packageName, if (ids.pill == null) R.layout.monitor_cam_bang_slim else R.layout.monitor_cam_bang)
            )
        }
        views.setInt(ids.root, "setBackgroundResource", if (asking) R.drawable.monitor_cam_bg_alert else R.drawable.monitor_cam_bg)

        val label = stateLabel(res, state)
        ids.pill?.let { pill ->
            views.setTextViewText(pill, label)
            views.setTextColor(pill, stateColor(state))
            views.setViewVisibility(pill, if (noSignal) View.GONE else View.VISIBLE)
        }
        ids.bar?.let { bar ->
            views.setProgressBar(bar, 100, camera?.progress ?: 0, false)
            tintProgress(views, bar, camera?.let { toneColor(it.tone) } ?: MUTED)
        }
        ids.kind?.let { kindId ->
            val kind = camera?.kind
            if (kind == null) {
                views.setViewVisibility(kindId, View.GONE)
            } else {
                views.setTextViewText(kindId, kind)
                views.setTextColor(kindId, kindColor(kind))
                views.setInt(kindId, "setBackgroundResource", kindChip(kind))
                views.setViewVisibility(kindId, View.VISIBLE)
            }
        }
        ids.name?.let { views.setTextViewText(it, camera?.providerLabel ?: "") }
        ids.cost?.let { views.setTextViewText(it, costText(res, camera?.cost ?: Cost.None, japanese)) }

        views.setContentDescription(ids.root, res.getString(R.string.monitor_widget_cam_description, channel, label))
        val step = camera?.stepIndex
        views.setOnClickPendingIntent(
            ids.root,
            if (step != null) link(context, model?.agentId, step, requestCode) else link(context, model?.agentId, null, requestCode)
        )
    }

    private fun costText(res: Context, cost: Cost, japanese: Boolean): String = when (cost) {
        is Cost.Money -> MonitorWidgetModel.formatMoney(cost.usd, japanese)
        is Cost.Tokens -> MonitorWidgetModel.formatTokens(cost.tokens)
        Cost.Plan -> res.getString(R.string.monitor_widget_cost_plan)
        Cost.Free -> MonitorWidgetModel.zeroMoney(japanese)
        Cost.None -> ""
    }

    private fun stateLabel(res: Context, state: CamState): String = res.getString(
        when (state) {
            CamState.STANDBY -> R.string.monitor_widget_state_standby
            CamState.RUNNING -> R.string.monitor_widget_state_running
            CamState.APPROVAL -> R.string.monitor_widget_state_approval
            CamState.DONE -> R.string.monitor_widget_state_done
            CamState.FAILED -> R.string.monitor_widget_state_failed
            CamState.STOPPED -> R.string.monitor_widget_state_stopped
            CamState.SKIPPED -> R.string.monitor_widget_state_skipped
            CamState.NO_SIGNAL -> R.string.monitor_widget_state_no_signal
        }
    )

    private fun stateColor(state: CamState): Int = when (state) {
        CamState.RUNNING -> PHOSPHOR
        CamState.APPROVAL -> AMBER
        CamState.DONE, CamState.STOPPED -> DONE
        CamState.FAILED -> FAIL
        else -> MUTED
    }

    private fun toneColor(tone: Tone): Int = when (tone) {
        Tone.LIVE -> PHOSPHOR
        Tone.AMBER -> AMBER
        Tone.DONE -> DONE
        Tone.FAIL -> FAIL
    }

    private fun kindColor(kind: String): Int = when (kind) {
        "API" -> K_API
        "CLI" -> K_CLI
        else -> K_LOCAL
    }

    private fun kindChip(kind: String): Int = when (kind) {
        "API" -> R.drawable.monitor_chip_api
        "CLI" -> R.drawable.monitor_chip_cli
        else -> R.drawable.monitor_chip_local
    }

    /** Progress colour per state; RemoteViews can only re-tint on API 31+. */
    private fun tintProgress(views: RemoteViews, id: Int, color: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setColorStateList(id, "setProgressTintList", ColorStateList.valueOf(color))
        }
    }

    private fun animationsEnabled(context: Context): Boolean = runCatching {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }.getOrDefault(true)

    /** Resources in the app's language (mirrored from lib/i18n), else the system's. */
    private fun localized(context: Context, appLocale: String?): Context {
        if (appLocale.isNullOrEmpty()) return context
        val config = Configuration(context.resources.configuration)
        config.setLocale(Locale(appLocale))
        return context.createConfigurationContext(config)
    }

    private fun link(context: Context, agentId: String?, step: Int?, requestCode: Int): PendingIntent {
        val builder = Uri.parse("shelly://monitor").buildUpon()
        if (agentId != null && MonitorWidgetRepository.isSafeAgentId(agentId)) {
            builder.appendQueryParameter("agentId", agentId)
            if (step != null && step >= 0) builder.appendQueryParameter("step", step.toString())
        }
        val intent = Intent(Intent.ACTION_VIEW, builder.build())
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun shorten(value: String, max: Int): String {
        val cleaned = value.replace(Regex("\\s+"), " ").trim()
        return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
    }
}

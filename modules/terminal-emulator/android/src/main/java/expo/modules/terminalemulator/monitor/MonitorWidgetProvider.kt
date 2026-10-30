package expo.modules.terminalemulator.monitor

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent

/**
 * MONITOR home-screen widget, 4x3 (header + cost/approval line + 2x2
 * cameras). [MonitorWidgetSlimProvider] is the 4x2 cameras-only variant.
 *
 * The provider only answers the launcher (placement, resize, reboot); all
 * run-driven updates are pushed by [MonitorWidgetUpdater]. No periodic
 * updates (updatePeriodMillis=0) and no alarms.
 */
open class MonitorWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            AppWidgetManager.ACTION_APPWIDGET_UPDATE,
            AppWidgetManager.ACTION_APPWIDGET_OPTIONS_CHANGED -> {
                val pending = goAsync()
                MonitorWidgetUpdater.requestUpdate(context, force = true) { pending.finish() }
            }
            else -> super.onReceive(context, intent)
        }
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        MonitorWidgetUpdater.requestUpdate(context, force = true)
    }
}

/** 4x2: the four cameras only. */
class MonitorWidgetSlimProvider : MonitorWidgetProvider()

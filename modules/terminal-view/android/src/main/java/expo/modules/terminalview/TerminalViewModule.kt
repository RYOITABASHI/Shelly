package expo.modules.terminalview

import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.terminalemulator.TerminalEmulatorModule
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class TerminalViewModule : Module() {
    private val mainHandler = Handler(Looper.getMainLooper())

    companion object {
        private const val TAG = "TerminalViewModule"

        /** Alias for the session registry in TerminalEmulatorModule */
        val sessionRegistry get() = TerminalEmulatorModule.sessionRegistry
    }

    override fun definition() = ModuleDefinition {
        Name("TerminalView")

        // --- Native View Registration ---
        View(ShellyTerminalView::class) {

            Events(
                "onOutput",
                "onBlockCompleted",
                "onBlockLongPress",
                "onSelectionChanged",
                "onUrlDetected",
                "onBell",
                "onTitleChanged",
                "onResize",
                "onScrollStateChanged",
                "onFocusRequested"
            )

            // --- Props ---

            Prop("sessionId") { view: ShellyTerminalView, sessionId: String? ->
                if (sessionId == null) {
                    view.detachCurrentSession()
                    return@Prop
                }

                val session = sessionRegistry[sessionId]
                if (session != null) {
                    view.attachShellySession(session, sessionId)
                } else {
                    Log.w(TAG, "Session $sessionId not found in registry")
                }
            }

            Prop("fontFamily") { view: ShellyTerminalView, family: String? ->
                if (family != null) {
                    view.setFontFamily(family)
                }
            }

            Prop("fontSize") { view: ShellyTerminalView, size: Int? ->
                if (size != null && size > 0) {
                    view.setFontSizeDp(size)
                }
            }

            Prop("cursorShape") { view: ShellyTerminalView, shape: String? ->
                if (shape != null) {
                    view.setCursorShape(shape)
                }
            }

            Prop("cursorBlink") { view: ShellyTerminalView, blink: Boolean? ->
                view.setCursorBlinkEnabled(blink ?: false)
            }

            Prop("gpuRendering") { view: ShellyTerminalView, enabled: Boolean? ->
                view.setGpuRendering(enabled ?: false)
            }

            Prop("colorScheme") { view: ShellyTerminalView, colors: Map<String, String>? ->
                if (colors != null && colors.isNotEmpty()) {
                    view.applyThemeColors(colors)
                }
            }

            Prop("transparentBackground") { view: ShellyTerminalView, enabled: Boolean? ->
                view.setTransparentBackground(enabled ?: false)
            }

            OnViewDestroys { view: ShellyTerminalView ->
                view.destroy()
            }
        }

        // --- Module-level functions for view commands ---

        AsyncFunction("registerSession") { sessionId: String ->
            Log.d(TAG, "registerSession called for $sessionId (session lookup deferred to prop setter)")
        }

        // View commands are called from JS with the React view tag (nativeID)
        // These find the view in the activity's view hierarchy and call the command

        AsyncFunction("scrollToBottom") { viewTag: Int ->
            runViewCommand(viewTag, "scrollToBottom") { it.scrollToBottomCommand() }
        }

        AsyncFunction("scrollToTop") { viewTag: Int ->
            runViewCommand(viewTag, "scrollToTop") { it.scrollToTopCommand() }
        }

        AsyncFunction("selectAll") { viewTag: Int ->
            runViewCommand(viewTag, "selectAll") { it.selectAllCommand() }
        }

        AsyncFunction("clearSelection") { viewTag: Int ->
            runViewCommand(viewTag, "clearSelection") { it.clearSelectionCommand() }
        }

        AsyncFunction("getSelectedText") { viewTag: Int ->
            runViewCommandSync(viewTag, "getSelectedText", "") {
                it.getSelectedTextCommand() ?: ""
            }
        }

        AsyncFunction("copyToClipboard") { viewTag: Int ->
            runViewCommandSync(viewTag, "copyToClipboard", false) {
                it.copyToClipboardCommand()
            }
        }

        AsyncFunction("focus") { viewTag: Int ->
            runViewCommand(viewTag, "focus") { it.focusCommand() }
        }

        AsyncFunction("scrollToRow") { viewTag: Int, row: Int ->
            runViewCommand(viewTag, "scrollToRow") { it.scrollToRowCommand(row) }
        }

        AsyncFunction("refreshScreen") { viewTag: Int ->
            runViewCommand(viewTag, "refreshScreen") { it.refreshScreenCommand() }
        }
    }

    private fun runViewCommand(
        viewTag: Int,
        command: String,
        block: (ShellyTerminalView) -> Unit
    ) {
        val task = Runnable {
            try {
                findView(viewTag)?.let(block)
            } catch (e: Exception) {
                Log.w(TAG, "Terminal view command failed: $command tag=$viewTag", e)
            }
        }

        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run()
        } else {
            mainHandler.post(task)
        }
    }

    private fun <T> runViewCommandSync(
        viewTag: Int,
        command: String,
        fallback: T,
        block: (ShellyTerminalView) -> T
    ): T {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return try {
                findView(viewTag)?.let(block) ?: fallback
            } catch (e: Exception) {
                Log.w(TAG, "Terminal view command failed: $command tag=$viewTag", e)
                fallback
            }
        }

        val result = AtomicReference<T>(fallback)
        val done = CountDownLatch(1)
        mainHandler.post {
            try {
                result.set(findView(viewTag)?.let(block) ?: fallback)
            } catch (e: Exception) {
                Log.w(TAG, "Terminal view command failed: $command tag=$viewTag", e)
            } finally {
                done.countDown()
            }
        }

        return try {
            if (done.await(1, TimeUnit.SECONDS)) result.get() else fallback
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            fallback
        }
    }

    private fun findView(viewTag: Int): ShellyTerminalView? {
        try {
            val activity = appContext.currentActivity ?: return null
            return activity.findViewById(viewTag) as? ShellyTerminalView
        } catch (e: Exception) {
            Log.w(TAG, "Could not find view with tag $viewTag", e)
            return null
        }
    }
}

package expo.modules.terminalview

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.terminalemulator.ShellyTerminalSession
import expo.modules.terminalemulator.TerminalEmulatorModule

class TerminalViewModule : Module() {

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
                "onSelectionChanged",
                "onUrlDetected",
                "onBell",
                "onTitleChanged"
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
            findView(viewTag)?.scrollToBottomCommand()
        }

        AsyncFunction("scrollToTop") { viewTag: Int ->
            findView(viewTag)?.scrollToTopCommand()
        }

        AsyncFunction("selectAll") { viewTag: Int ->
            findView(viewTag)?.selectAllCommand()
        }

        AsyncFunction("clearSelection") { viewTag: Int ->
            findView(viewTag)?.clearSelectionCommand()
        }

        AsyncFunction("getSelectedText") { viewTag: Int ->
            findView(viewTag)?.getSelectedTextCommand() ?: ""
        }

        AsyncFunction("copyToClipboard") { viewTag: Int ->
            findView(viewTag)?.copyToClipboardCommand() ?: false
        }

        AsyncFunction("focus") { viewTag: Int ->
            findView(viewTag)?.focusCommand()
        }
    }

    private fun findView(viewTag: Int): ShellyTerminalView? {
        return try {
            val activity = appContext.currentActivity ?: return null
            activity.findViewById(viewTag) as? ShellyTerminalView
        } catch (e: Exception) {
            Log.w(TAG, "Could not find view with tag $viewTag", e)
            null
        }
    }
}

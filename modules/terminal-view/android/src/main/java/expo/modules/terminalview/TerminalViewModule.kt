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
                "onBlockLongPress",
                "onSelectionChanged",
                "onUrlDetected",
                "onBell",
                "onTitleChanged",
                "onResize",
                "onScrollStateChanged"
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

            // Phase B (2026-04-21): when the user sets a wallpaper, the JS
            // side flips this on so the terminal view + its inner TerminalView
            // stop painting an opaque background behind the text. Cells with
            // the default scheme background are already skipped by
            // TerminalRenderer.render (see the `backColor != palette[BG]`
            // guard at TerminalRenderer:231), so making the Android View
            // itself transparent is enough to let the wallpaper bleed through.
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

        AsyncFunction("scrollToRow") { viewTag: Int, row: Int ->
            findView(viewTag)?.scrollToRowCommand(row)
        }

        AsyncFunction("refreshScreen") { viewTag: Int ->
            findView(viewTag)?.refreshScreenCommand()
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

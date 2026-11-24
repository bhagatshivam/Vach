package com.vach.reader

import android.graphics.Color
import android.os.Build
import android.util.Log
import androidx.core.view.WindowCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

private const val TAG = "SystemThemePlugin"

/**
 * Makes everything around the web page match the reader's theme, so there is
 * no white frame, white bar or white flash behind it:
 *
 *  - the window (decor view) background, which is what shows behind the
 *    status/navigation bars when the system pads the web view instead of
 *    letting it draw underneath (older WebViews),
 *  - the WebView's own background, shown before a page paints,
 *  - the dark/light appearance of the status and navigation bar ICONS, so the
 *    clock and gesture handle contrast with the theme.
 *
 * The page itself draws edge to edge (viewport-fit=cover). On Android 15+
 * (this app targets 36) the bars are transparent and show the page, so the page
 * background does the real work there; the rest is for older versions and for
 * the moments before the page has painted. Capacitor's own SystemBars plugin
 * also resets the window background and icon appearance whenever the
 * configuration changes (rotation, dark mode), so this plugin re-applies the
 * last request right after it.
 *
 * Offline and permission-free: it touches only this app's own window.
 */
@CapacitorPlugin(name = "SystemTheme")
class SystemThemePlugin : Plugin() {

    private var background: Int? = null
    private var darkIcons: Boolean = true

    @PluginMethod
    fun apply(call: PluginCall) {
        val hex = call.getString("background")
        val color = try {
            if (hex != null && (hex.length == 7 || hex.length == 9) && hex.startsWith("#")) Color.parseColor(hex) else null
        } catch (e: IllegalArgumentException) {
            null
        }
        if (color == null) {
            call.reject("'background' must be a #rrggbb colour")
            return
        }
        background = color
        darkIcons = call.getBoolean("darkIcons", true) ?: true
        bridge.executeOnMainThread {
            applyNow()
            call.resolve()
        }
    }

    // Runs after SystemBars' own handler (posted to the end of the queue), so the theme wins.
    override fun handleOnConfigurationChanged(newConfig: android.content.res.Configuration?) {
        super.handleOnConfigurationChanged(newConfig)
        if (background == null) return
        bridge.webView?.post { applyNow() }
    }

    @Suppress("DEPRECATION")
    private fun applyNow() {
        val color = background ?: return
        try {
            val window = activity.window
            val decor = window.decorView
            decor.setBackgroundColor(color)
            bridge.webView?.setBackgroundColor(color)

            val controller = WindowCompat.getInsetsController(window, decor)
            // "Light" appearance = dark icons, for a light background.
            controller.isAppearanceLightStatusBars = darkIcons
            controller.isAppearanceLightNavigationBars = darkIcons

            // Android 14 and below (edge-to-edge is only enforced from 15): colour the bars themselves.
            window.statusBarColor = color
            window.navigationBarColor = color
            // Android 10+: no translucent scrim behind the 3-button navigation bar.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
            }
        } catch (t: Throwable) {
            // Cosmetic only: never let it take the app down.
            Log.w(TAG, "applyNow() failed", t)
        }
    }
}

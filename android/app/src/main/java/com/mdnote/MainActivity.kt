package com.mdnote

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {

  private var pendingShareText: String? = null
  private val handler = Handler(Looper.getMainLooper())

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "MDNote"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        override fun getLaunchOptions(): Bundle? {
          val initialProps = Bundle()
          val intent = intent
          if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
             val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
             if (sharedText != null) {
               initialProps.putString("sharedText", sharedText)
             }
          }
          return initialProps
        }
      }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    setIntent(intent)
    intent?.let { handleShareIntent(it) }
  }

  private fun handleShareIntent(intent: Intent?) {
    if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
      val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
      if (sharedText != null) {
        sendEventToReactNative(sharedText)
      }
    }
  }

  private fun sendEventToReactNative(data: String) {
    try {
      val reactContext = reactInstanceManager?.currentReactContext
      if (reactContext != null) {
        android.util.Log.d("MainActivity", "Sending share event to React Native")
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit("onShareReceived", data)
      } else {
        android.util.Log.w("MainActivity", "React context not available, caching share content")
        // Cache the share content and retry
        pendingShareText = data
        retryShareEvent()
      }
    } catch (e: Exception) {
      android.util.Log.e("MainActivity", "Error sending share event", e)
    }
  }

  private fun retryShareEvent() {
    var attempts = 0
    val maxAttempts = 30 // Try for 3 seconds

    val retryRunnable = object : Runnable {
      override fun run() {
        attempts++
        val reactContext = reactInstanceManager?.currentReactContext

        if (reactContext != null && pendingShareText != null) {
          android.util.Log.d("MainActivity", "React context ready after $attempts attempts, sending cached share event")
          try {
            reactContext
              .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              ?.emit("onShareReceived", pendingShareText)
            pendingShareText = null // Clear after successful send
          } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error sending cached share event", e)
          }
        } else if (attempts < maxAttempts) {
          android.util.Log.d("MainActivity", "Retry share event, attempt $attempts")
          handler.postDelayed(this, 100) // Retry after 100ms
        } else {
          android.util.Log.e("MainActivity", "Failed to send share event after $maxAttempts attempts")
          pendingShareText = null // Clear after max attempts
        }
      }
    }

    handler.postDelayed(retryRunnable, 100)
  }
}

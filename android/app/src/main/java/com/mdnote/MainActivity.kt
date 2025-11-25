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
  private var lastProcessedIntentTime = 0L
  private val handler = Handler(Looper.getMainLooper())

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    android.util.Log.d("MainActivity", "onCreate called")
  }

  override fun onResume() {
    super.onResume()
    android.util.Log.d("MainActivity", "onResume called")
    // Handle share intent in onResume as a fallback for systems where onNewIntent might not be called
    handleShareIntent(intent)
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
    android.util.Log.d("MainActivity", "onNewIntent called with action: ${intent?.action}")
    setIntent(intent)
    intent?.let { handleShareIntent(it) }
  }

  private fun handleShareIntent(intent: Intent?) {
    if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
      val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
      android.util.Log.d("MainActivity", "Found share intent with text: ${sharedText?.take(50)}")

      if (sharedText != null) {
        // Prevent duplicate processing of the same intent
        val currentTime = System.currentTimeMillis()
        if (currentTime - lastProcessedIntentTime < 1000) {
          android.util.Log.d("MainActivity", "Skipping duplicate intent (within 1 second)")
          return
        }
        lastProcessedIntentTime = currentTime

        sendEventToReactNative(sharedText)
      }
    } else {
      android.util.Log.d("MainActivity", "Intent action: ${intent?.action}, type: ${intent?.type}")
    }
  }

  private fun sendEventToReactNative(data: String) {
    try {
      // Use new architecture compatible method to get React context
      val reactContext = try {
        reactActivityDelegate?.getCurrentReactContext()
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "Cannot access ReactContext: ${e.message}")
        null
      }

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
      // Cache and retry even on error
      pendingShareText = data
      retryShareEvent()
    }
  }

  private fun retryShareEvent() {
    var attempts = 0
    val maxAttempts = 30 // Try for 3 seconds

    val retryRunnable = object : Runnable {
      override fun run() {
        attempts++

        // Use new architecture compatible method to get React context
        val reactContext = try {
          reactActivityDelegate?.getCurrentReactContext()
        } catch (e: Exception) {
          null
        }

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

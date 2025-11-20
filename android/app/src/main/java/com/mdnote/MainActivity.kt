package com.mdnote

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {

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
    android.util.Log.d("MainActivity", "onNewIntent received: ${intent?.action}")
    setIntent(intent)
    intent?.let { handleShareIntent(it) }
  }

  private fun handleShareIntent(intent: Intent?) {
    if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
      val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
      android.util.Log.d("MainActivity", "Handling share intent. Text: $sharedText")
      if (sharedText != null) {
        sendEventToReactNative(sharedText)
      }
    }
  }

  private fun sendEventToReactNative(data: String) {
    try {
      val reactContext = reactInstanceManager?.currentReactContext
      android.util.Log.d("MainActivity", "Sending event to RN. Context exists: ${reactContext != null}")
      if (reactContext != null) {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit("onShareReceived", data)
      } else {
          // Retry once after a short delay if context is null (though unlikely in warm start)
          android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
              val retryContext = reactInstanceManager?.currentReactContext
              android.util.Log.d("MainActivity", "Retry sending event. Context exists: ${retryContext != null}")
              retryContext
                  ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                  ?.emit("onShareReceived", data)
          }, 1000)
      }
    } catch (e: Exception) {
      android.util.Log.e("MainActivity", "Error sending share event", e)
    }
  }
}

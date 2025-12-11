const { withAndroidManifest, withMainActivity, AndroidConfig } = require('@expo/config-plugins');

const withAndroidShare = (config) => {
  config = withShareIntentFilter(config);
  config = withShareActivityModification(config);
  return config;
};

// 1. Add <intent-filter> to AndroidManifest.xml
const withShareIntentFilter = (config) => {
  return withAndroidManifest(config, async (config) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);

    // Check if filter already exists to avoid duplicates
    const hasShareIntent = mainActivity['intent-filter']?.some(filter =>
      filter.action?.some(action => action.$['android:name'] === 'android.intent.action.SEND')
    );

    if (!hasShareIntent) {
      if (!mainActivity['intent-filter']) {
        mainActivity['intent-filter'] = [];
      }
      mainActivity['intent-filter'].push({
        action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': 'text/plain' } }]
      });
    }

    return config;
  });
};

// 2. Inject Kotlin code into MainActivity.kt
const withShareActivityModification = (config) => {
  return withMainActivity(config, async (config) => {
    let content = config.modResults.contents;

    // A. Add Imports
    if (!content.includes('import android.content.Intent')) {
      const imports = `
import android.content.Intent
import com.facebook.react.modules.core.DeviceEventManagerModule
`;
      content = content.replace(/import android.os.Bundle/, `import android.os.Bundle${imports}`);
    }

    // B. Add Class Members
    if (!content.includes('private var pendingShareText')) {
      const classMembers = `
  private var pendingShareText: String? = null
  private var isRetrying = false
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
`;
      // Inject at the beginning of the class
      content = content.replace(/class MainActivity : ReactActivity\(\) \{/, `class MainActivity : ReactActivity() {${classMembers}`);
    }

    // C. Add Helper Methods and onNewIntent
    // We add them before the last closing brace of the class.
    if (!content.includes('private fun sendEventToReactNative')) {
      const additionalMethods = `
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleShareIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    // Retry sending pending share if context becomes available on resume
    if (pendingShareText != null) {
        retryShareEvent()
    }
  }

  private fun handleShareIntent(intent: Intent?) {
    val action = intent?.action
    val type = intent?.type
    
    // Stage 1: Intent Received
    if (Intent.ACTION_SEND == action) {
        android.util.Log.i("MainActivity", "[Share] 1. Received SEND Intent. Type: " + type)
        
        if (type != null && type.startsWith("text/")) {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
            val len = sharedText?.length ?: 0
            
            // Stage 2: Content Extraction
            if (sharedText != null) {
                android.util.Log.i("MainActivity", "[Share] 2. Content extracted. Length: " + len)
                sendEventToReactNative(sharedText)
            } else {
                android.util.Log.e("MainActivity", "[Share] 2. FAILED: Content is null")
            }
        } else {
            android.util.Log.w("MainActivity", "[Share] 1. Skipped: Unsupported type " + type)
        }
    }
    // Ignore other actions quietly to keep logs clean
  }

  // Helper to get ReactContext robustly
  private fun getReactContext(): com.facebook.react.bridge.ReactContext? {
    var ctx: com.facebook.react.bridge.ReactContext? = null

    // 1. Try ReactHost (New Architecture)
    try {
        val app = application as com.facebook.react.ReactApplication
        ctx = app.reactHost?.currentReactContext
        if (ctx != null) return ctx
    } catch (e: Exception) {}

    // 2. Standard ReactInstanceManager
    try {
        ctx = reactInstanceManager.currentReactContext
        if (ctx != null) return ctx
    } catch (e: Exception) {}

    // 3. Delegate's InstanceManager
    try {
        if (reactActivityDelegate != null) {
             ctx = reactActivityDelegate.reactInstanceManager.currentReactContext
             if (ctx != null) return ctx
        }
    } catch (e: Exception) {}

    // 4. Application's ReactNativeHost
    try {
        val app = application as com.facebook.react.ReactApplication
        ctx = app.reactNativeHost.reactInstanceManager.currentReactContext
        if (ctx != null) return ctx
    } catch (e: Exception) {}
    
    return null
  }

  private fun sendEventToReactNative(data: String) {
    val reactContext = getReactContext()

    if (reactContext != null) {
        // Stage 3: Context Check - Success
        // Stage 4: Emission
        try {
            reactContext
              .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              ?.emit("onShareReceived", data)
            android.util.Log.i("MainActivity", "[Share] 4. Success: Event emitted to JS.")
            pendingShareText = null 
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "[Share] 4. FAILED: Emission error", e)
            pendingShareText = data
            retryShareEvent()
        }
    } else {
        // Stage 3: Context Check - Failed (Retry needed)
        android.util.Log.w("MainActivity", "[Share] 3. Context not ready. Queuing retry...")
        pendingShareText = data
        retryShareEvent()
    }
  }

  private fun retryShareEvent() {
    if (isRetrying) return 
    isRetrying = true
    
    var attempts = 0
    val maxAttempts = 300 // 30 seconds

    val retryRunnable = object : Runnable {
      override fun run() {
        attempts++
        val reactContext = getReactContext()
        
        // Log only milestones to reduce noise
        if (attempts == 1 || attempts % 50 == 0) {
             android.util.Log.i("MainActivity", "[Share] Retry Status: Attempt " + attempts + "/" + maxAttempts + ". Context ready? " + (reactContext != null))
        }

        if (reactContext != null && pendingShareText != null) {
          try {
            reactContext
              .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              ?.emit("onShareReceived", pendingShareText)
            
            android.util.Log.i("MainActivity", "[Share] Retry Success: Event emitted at attempt " + attempts)
            pendingShareText = null
            isRetrying = false
          } catch (e: Exception) {
            android.util.Log.e("MainActivity", "[Share] Retry Failed: Emission error", e)
            isRetrying = false
          }
        } else if (attempts < maxAttempts && pendingShareText != null) {
           handler.postDelayed(this, 100)
        } else {
           isRetrying = false
           if (pendingShareText != null) {
               android.util.Log.e("MainActivity", "[Share] Retry FAILED: Timed out after 30s.")
           }
        }
      }
    }
    handler.postDelayed(retryRunnable, 100)
  }
`;
      // Find the last closing brace '}'
      const lastBraceIndex = content.lastIndexOf('}');
      if (lastBraceIndex !== -1) {
        content = content.slice(0, lastBraceIndex) + additionalMethods + content.slice(lastBraceIndex);
      }
    }

    // D. Hook into onCreate
    // Only if handleShareIntent is not already called in onCreate
    // We look for super.onCreate(null)
    if (content.includes('super.onCreate(null)') && !content.includes('handleShareIntent(intent) // Injected')) {
      content = content.replace('super.onCreate(null)', 'super.onCreate(null)\n    handleShareIntent(intent) // Injected');
    }

    // E. Modify createReactActivityDelegate to pass initialProps (Cold Start Fix)
    const oldDelegate = `
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }
`;

    const newDelegate = `
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){
            override fun getLaunchOptions(): Bundle? {
              val initialProps = Bundle()
              val sharedText = intent?.getStringExtra(Intent.EXTRA_TEXT)
              val type = intent?.type
              android.util.Log.i("MainActivity", "getLaunchOptions: type=" + type + ", sharedText=" + (if (sharedText != null) "found" else "null"))
              if (intent?.action == Intent.ACTION_SEND && type != null && type.startsWith("text/") && sharedText != null) {
                android.util.Log.i("MainActivity", "getLaunchOptions: Injecting sharedText into initialProps")
                initialProps.putString("sharedText", sharedText)
              }
              return initialProps
            }
          })
  }
`;

    // Normalize whitespace for comparison (optional but safer) or just replace directly
    // Since we know the exact string from previous file read:
    if (content.includes('object : DefaultReactActivityDelegate(') && !content.includes('getLaunchOptions')) {
      // We try to replace the whole function block.
      // Note: Regex might be safer to handle varying whitespace, but direct string replacement is safer if exact match.
      // Let's try to match the "closure" of the object expression.
      content = content.replace(/object : DefaultReactActivityDelegate\(\s*this,\s*mainComponentName,\s*fabricEnabled\s*\)\{\}/,
        `object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){
            override fun getLaunchOptions(): Bundle? {
              val initialProps = Bundle()
              val sharedText = intent?.getStringExtra(Intent.EXTRA_TEXT)
              val type = intent?.type
              android.util.Log.i("MainActivity", "getLaunchOptions: type=" + type + ", sharedText=" + (if (sharedText != null) "found" else "null"))
              if (intent?.action == Intent.ACTION_SEND && type != null && type.startsWith("text/") && sharedText != null) {
                android.util.Log.i("MainActivity", "getLaunchOptions: Injecting sharedText into initialProps")
                initialProps.putString("sharedText", sharedText)
              }
              return initialProps
            }
          }`);
    }

    config.modResults.contents = content;
    return config;
  });
};

module.exports = withAndroidShare;

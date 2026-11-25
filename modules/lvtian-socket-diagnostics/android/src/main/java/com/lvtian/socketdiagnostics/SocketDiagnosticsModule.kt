package com.lvtian.socketdiagnostics

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.websocket.WebSocketModule
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import okio.ByteString

class SocketDiagnosticsModule : Module() {
  private data class SyncArrival(val timestamp: Long, val characters: Int)

  private class ReceiveObserver : WebSocketModule.ContentHandler {
    @Volatile var syncArrival: SyncArrival? = null
      private set

    override fun onMessage(text: String, params: WritableMap) {
      if (text.startsWith("{\"type\":\"sync_result\",")) {
        syncArrival = SyncArrival(System.currentTimeMillis(), text.length)
      }
      params.putString("data", text)
    }

    override fun onMessage(byteString: ByteString, params: WritableMap) {
      params.putString("data", byteString.base64())
    }
  }

  private val observers = ConcurrentHashMap<Int, ReceiveObserver>()

  private fun socketModule() = (appContext.reactContext as? ReactApplicationContext)
    ?.getNativeModule(WebSocketModule::class.java)

  override fun definition() = ModuleDefinition {
    Name("LvtianSocketDiagnostics")

    Function("track") { socketId: Int ->
      val socket = socketModule()
      if (socket == null) {
        false
      } else {
        val observer = ReceiveObserver()
        observers[socketId] = observer
        socket.setContentHandler(socketId, observer)
        true
      }
    }

    Function("snapshot") { socketId: Int ->
      observers[socketId]?.syncArrival?.let {
        mapOf("nativeSyncAtMs" to it.timestamp.toDouble(), "nativeSyncChars" to it.characters.toDouble())
      }
    }

    Function("stop") { socketId: Int ->
      if (observers.remove(socketId) != null) socketModule()?.setContentHandler(socketId, null)
      Unit
    }
  }
}

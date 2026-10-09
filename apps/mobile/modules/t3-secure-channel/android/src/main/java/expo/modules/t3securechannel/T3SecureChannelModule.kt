package expo.modules.t3securechannel

import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

/**
 * Native pieces of the secure channel: ChaCha20-Poly1305 for its frames, synchronous so the
 * channel's pure state machine can call it inline (the platform cipher arrived in API 28; below
 * that the app keeps the JavaScript implementation), and the loopback listener an encrypted route
 * is reached through. Each accepted connection's bytes go to JavaScript, which carries them as a
 * channel stream.
 */
class T3SecureChannelModule : Module() {
  private val listeners = ConcurrentHashMap<String, ServerSocket>()
  private val connections = ConcurrentHashMap<String, LoopbackConnection>()

  override fun definition() = ModuleDefinition {
    Name("T3SecureChannel")

    Events("onConnection", "onData", "onEnd", "onClose")

    Function("isAvailable") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    }

    Function("seal") { key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray ->
      cipher(Cipher.ENCRYPT_MODE, key, nonce, ad).doFinal(plaintext)
    }

    Function("open") { key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray ->
      try {
        cipher(Cipher.DECRYPT_MODE, key, nonce, ad).doFinal(ciphertext)
      } catch (cause: Exception) {
        throw ChannelOpenException(cause)
      }
    }

    /** Listens on 127.0.0.1 at a port the system picks. */
    AsyncFunction("startListener") { promise: Promise ->
      val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
      val listenerId = UUID.randomUUID().toString()
      listeners[listenerId] = server
      thread(name = "t3-secure-channel-accept", isDaemon = true) { acceptLoop(listenerId, server) }
      promise.resolve(mapOf("listenerId" to listenerId, "port" to server.localPort))
    }

    Function("stopListener") { listenerId: String ->
      listeners.remove(listenerId)?.close()
      connections.values.filter { it.listenerId == listenerId }.forEach { it.socket.close() }
    }

    /** Resolves once the bytes are written, which is when the channel grants more. */
    AsyncFunction("write") { connectionId: String, data: ByteArray, promise: Promise ->
      val connection = connections[connectionId]
      if (connection == null) {
        promise.resolve(null)
      } else {
        connection.writer.execute {
          try {
            connection.socket.getOutputStream().apply {
              write(data)
              flush()
            }
          } catch (_: IOException) {
            // The reader reports the close.
          }
          promise.resolve(null)
        }
      }
    }

    Function("end") { connectionId: String ->
      val connection = connections[connectionId] ?: return@Function
      connection.writer.execute {
        try {
          connection.socket.shutdownOutput()
        } catch (_: IOException) {
          // Already closed.
        }
        connection.sentFinal = true
        closeIfDone(connection)
      }
    }

    Function("destroy") { connectionId: String ->
      connections[connectionId]?.socket?.close()
    }

    Function("pause") { connectionId: String ->
      connections[connectionId]?.setPaused(true)
    }

    Function("resume") { connectionId: String ->
      connections[connectionId]?.setPaused(false)
    }
  }

  private fun acceptLoop(listenerId: String, server: ServerSocket) {
    while (!server.isClosed) {
      val socket = try {
        server.accept()
      } catch (_: IOException) {
        return
      }
      socket.tcpNoDelay = true
      val connection = LoopbackConnection(UUID.randomUUID().toString(), listenerId, socket)
      connections[connection.id] = connection
      sendEvent("onConnection", mapOf("listenerId" to listenerId, "connectionId" to connection.id))
      thread(name = "t3-secure-channel-read", isDaemon = true) { readLoop(connection) }
    }
  }

  private fun readLoop(connection: LoopbackConnection) {
    val buffer = ByteArray(65_536)
    try {
      val input = connection.socket.getInputStream()
      while (true) {
        connection.awaitUnpaused()
        val count = input.read(buffer)
        if (count < 0) {
          connection.receivedFinal = true
          sendEvent("onEnd", mapOf("connectionId" to connection.id))
          closeIfDone(connection)
          return
        }
        sendEvent("onData", mapOf("connectionId" to connection.id, "data" to buffer.copyOf(count)))
      }
    } catch (error: IOException) {
      close(connection, error.message ?: "The connection failed.")
    }
  }

  /** A connection whose halves have both ended is closed cleanly. */
  private fun closeIfDone(connection: LoopbackConnection) {
    if (connection.sentFinal && connection.receivedFinal) {
      connection.socket.close()
      close(connection, null)
    }
  }

  private fun close(connection: LoopbackConnection, error: String?) {
    if (connections.remove(connection.id) == null) return
    connection.writer.shutdown()
    sendEvent(
      "onClose",
      if (error == null) mapOf("connectionId" to connection.id)
      else mapOf("connectionId" to connection.id, "error" to error),
    )
  }

  private fun cipher(mode: Int, key: ByteArray, nonce: ByteArray, ad: ByteArray): Cipher =
    Cipher.getInstance("ChaCha20-Poly1305").apply {
      init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
      updateAAD(ad)
    }
}

private class LoopbackConnection(val id: String, val listenerId: String, val socket: Socket) {
  /** One writer per connection keeps its writes in order. */
  val writer: ExecutorService = Executors.newSingleThreadExecutor()
  @Volatile var sentFinal = false
  @Volatile var receivedFinal = false
  private val lock = Object()
  private var paused = false

  fun setPaused(value: Boolean) = synchronized(lock) {
    paused = value
    if (!value) lock.notifyAll()
  }

  fun awaitUnpaused() = synchronized(lock) {
    while (paused) lock.wait()
  }
}

internal class ChannelOpenException(cause: Throwable) :
  CodedException("A channel frame failed to authenticate.", cause)

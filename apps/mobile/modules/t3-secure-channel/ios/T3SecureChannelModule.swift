import CryptoKit
import ExpoModulesCore
import Network

/// Native pieces of the secure channel: ChaCha20-Poly1305 for its frames, synchronous so the
/// channel's pure state machine can call it inline, and the loopback listener an encrypted route
/// is reached through. Each accepted connection's bytes go to JavaScript, which carries them as a
/// channel stream; the app's own loaders then use the route at `http://127.0.0.1:<port>`.
public class T3SecureChannelModule: Module {
  private let queue = DispatchQueue(label: "com.t3tools.securechannel")
  private var listeners: [String: NWListener] = [:]
  private var connections: [String: LoopbackConnection] = [:]

  public func definition() -> ModuleDefinition {
    Name("T3SecureChannel")

    Events("onConnection", "onData", "onEnd", "onClose")

    Function("isAvailable") { () -> Bool in
      true
    }

    Function("seal") { (key: Data, nonce: Data, ad: Data, plaintext: Data) throws -> Data in
      let box = try ChaChaPoly.seal(
        plaintext,
        using: SymmetricKey(data: key),
        nonce: ChaChaPoly.Nonce(data: nonce),
        authenticating: ad
      )
      return box.ciphertext + box.tag
    }

    Function("open") { (key: Data, nonce: Data, ad: Data, ciphertext: Data) throws -> Data in
      guard ciphertext.count >= 16 else { throw ChannelOpenException() }
      do {
        let box = try ChaChaPoly.SealedBox(
          nonce: ChaChaPoly.Nonce(data: nonce),
          ciphertext: ciphertext.prefix(ciphertext.count - 16),
          tag: ciphertext.suffix(16)
        )
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
      } catch {
        throw ChannelOpenException()
      }
    }

    /// Listens on 127.0.0.1 at a port the system picks, resolving once it's ready.
    AsyncFunction("startListener") { (promise: Promise) in
      self.queue.async {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        guard let listener = try? NWListener(using: parameters) else {
          promise.reject(ListenerException())
          return
        }
        let listenerId = UUID().uuidString
        var settled = false
        listener.stateUpdateHandler = { [weak self] state in
          switch state {
          case .ready:
            if !settled, let port = listener.port?.rawValue {
              settled = true
              self?.listeners[listenerId] = listener
              promise.resolve(["listenerId": listenerId, "port": Int(port)])
            }
          case .failed, .cancelled:
            self?.listeners[listenerId] = nil
            if !settled {
              settled = true
              promise.reject(ListenerException())
            }
          default:
            break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          self?.accept(connection, listenerId: listenerId)
        }
        listener.start(queue: self.queue)
      }
    }

    Function("stopListener") { (listenerId: String) in
      self.queue.async {
        self.listeners.removeValue(forKey: listenerId)?.cancel()
        for (id, connection) in self.connections where connection.listenerId == listenerId {
          connection.connection.cancel()
          self.connections[id] = nil
        }
      }
    }

    /// Resolves once the bytes are handed to the network, which is when the channel grants more.
    AsyncFunction("write") { (connectionId: String, data: Data, promise: Promise) in
      self.queue.async {
        guard let connection = self.connections[connectionId] else {
          promise.resolve(nil)
          return
        }
        connection.connection.send(content: data, completion: .contentProcessed { _ in promise.resolve(nil) })
      }
    }

    Function("end") { (connectionId: String) in
      self.queue.async {
        guard let entry = self.connections[connectionId] else { return }
        entry.sentFinal = true
        entry.connection.send(
          content: nil, contentContext: .finalMessage, isComplete: true,
          completion: .contentProcessed { [weak self] _ in self?.closeIfDone(entry) })
      }
    }

    Function("destroy") { (connectionId: String) in
      self.queue.async {
        self.connections.removeValue(forKey: connectionId)?.connection.cancel()
      }
    }

    Function("pause") { (connectionId: String) in
      self.queue.async { self.connections[connectionId]?.paused = true }
    }

    Function("resume") { (connectionId: String) in
      self.queue.async {
        guard let connection = self.connections[connectionId], connection.paused else { return }
        connection.paused = false
        if !connection.reading { self.receive(connection) }
      }
    }
  }

  private func accept(_ connection: NWConnection, listenerId: String) {
    let id = UUID().uuidString
    let entry = LoopbackConnection(connection: connection, listenerId: listenerId)
    connections[id] = entry
    entry.id = id
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.sendEvent("onConnection", ["listenerId": listenerId, "connectionId": id])
        self?.receive(entry)
      case .failed(let error):
        self?.close(entry, error: error.localizedDescription)
      case .cancelled:
        self?.close(entry, error: nil)
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  private func receive(_ entry: LoopbackConnection) {
    entry.reading = true
    entry.connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      entry.reading = false
      if let data, !data.isEmpty {
        self.sendEvent("onData", ["connectionId": entry.id, "data": data])
      }
      if isComplete {
        entry.receivedFinal = true
        self.sendEvent("onEnd", ["connectionId": entry.id])
        self.closeIfDone(entry)
        return
      }
      if let error {
        self.close(entry, error: error.localizedDescription)
        return
      }
      if !entry.paused { self.receive(entry) }
    }
  }

  /// A connection whose halves have both ended doesn't close by itself.
  private func closeIfDone(_ entry: LoopbackConnection) {
    if entry.sentFinal && entry.receivedFinal { entry.connection.cancel() }
  }

  private func close(_ entry: LoopbackConnection, error: String?) {
    guard connections.removeValue(forKey: entry.id) != nil else { return }
    var body: [String: Any] = ["connectionId": entry.id]
    if let error { body["error"] = error }
    sendEvent("onClose", body)
  }
}

private final class LoopbackConnection {
  let connection: NWConnection
  let listenerId: String
  var id = ""
  var paused = false
  var reading = false
  var sentFinal = false
  var receivedFinal = false

  init(connection: NWConnection, listenerId: String) {
    self.connection = connection
    self.listenerId = listenerId
  }
}

internal final class ChannelOpenException: Exception {
  override var reason: String {
    "A channel frame failed to authenticate."
  }
}

internal final class ListenerException: Exception {
  override var reason: String {
    "The secure channel's local listener couldn't start."
  }
}

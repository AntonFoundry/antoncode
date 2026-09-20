import Cocoa

/// URLSession client for the Anton bridge and, through it, the Harness API.
/// Unary calls speak the harness apiproxy envelope
/// `{type:"client-request", rpcId, method, payload}` → `{result:{ok,value}}`.
/// Answers are not carried by unary calls (admission only): assistant text
/// arrives on the `/api/events.mux` downlink WebSocket, parsed in `MuxStream`.
final class HarnessClient {
  static let errorDomain = "HarnessClient"

  /// The bridge listens on loopback only; sending no Origin header keeps the
  /// bridge's same-origin fence satisfied via its loopback-control rule.
  private let baseURL = URL(string: "http://127.0.0.1:3742")!
  private let session = URLSession(configuration: .ephemeral)

  struct HarnessError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  // MARK: Unary RPC

  private func rpc(_ method: String, _ payload: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
    var request = URLRequest(url: baseURL.appendingPathComponent("api/\(method)"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 30
    let body: [String: Any] = [
      "type": "client-request",
      "rpcId": UUID().uuidString,
      "method": method,
      "payload": payload,
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    session.dataTask(with: request) { data, _, error in
      if let error {
        completion(.failure(error))
        return
      }
      guard let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let result = obj["result"] as? [String: Any] else {
        completion(.failure(HarnessError(message: "malformed response from harness")))
        return
      }
      if result["ok"] as? Bool == true {
        completion(.success(result["value"] as Any))
      } else {
        let message = ((result["error"] as? [String: Any])?["message"] as? String) ?? "harness rejected \(method)"
        completion(.failure(HarnessError(message: message)))
      }
    }.resume()
  }

  /// GET /bridge/api/status → harness running flag.
  func harnessRunning(_ completion: @escaping (Bool) -> Void) {
    let url = baseURL.appendingPathComponent("bridge/api/status")
    session.dataTask(with: url) { data, _, _ in
      var running = false
      if let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
         let harness = obj["harness"] as? [String: Any] {
        running = harness["running"] as? Bool ?? false
      }
      DispatchQueue.main.async { completion(running) }
    }.resume()
  }

  /// POST /bridge/api/harness/start — wakes the harness before an ask.
  func startHarness(_ completion: @escaping (Result<Void, Error>) -> Void) {
    var request = URLRequest(url: baseURL.appendingPathComponent("bridge/api/harness/start"))
    request.httpMethod = "POST"
    request.timeoutInterval = 60
    session.dataTask(with: request) { _, response, error in
      if let error {
        completion(.failure(error))
        return
      }
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        completion(.failure(HarnessError(message: "harness start failed")))
        return
      }
      completion(.success(()))
    }.resume()
  }

  func createSession(cwd: String, preset: String, completion: @escaping (Result<String, Error>) -> Void) {
    rpc("session.create", ["cwd": cwd, "agentPreset": preset]) { result in
      switch result {
      case .success(let value):
        if let sessionId = (value as? [String: Any])?["sessionId"] as? String {
          completion(.success(sessionId))
        } else {
          completion(.failure(HarnessError(message: "session.create returned no sessionId")))
        }
      case .failure(let error):
        completion(.failure(error))
      }
    }
  }

  func prompt(sessionId: String, text: String, completion: @escaping (Result<Void, Error>) -> Void) {
    rpc("session.prompt", [
      "sessionId": sessionId,
      "mode": "queue",
      "content": [["type": "text", "text": text]],
    ]) { result in
      switch result {
      case .success: completion(.success(()))
      case .failure(let error): completion(.failure(error))
      }
    }
  }

  func cancel(sessionId: String) {
    rpc("session.cancel", ["sessionId": sessionId]) { _ in }
  }

  /// POST /api/session.fork — copies the session; the response carries the
  /// child sessionId. The full transcript (question and answer) travels with
  /// the copy.
  func fork(sessionId: String, completion: @escaping (Result<String, Error>) -> Void) {
    rpc("session.fork", ["sessionId": sessionId]) { result in
      switch result {
      case .success(let value):
        if let childId = (value as? [String: Any])?["sessionId"] as? String {
          completion(.success(childId))
        } else {
          completion(.failure(HarnessError(message: "session.fork returned no sessionId")))
        }
      case .failure(let error):
        completion(.failure(error))
      }
    }
  }

  /// POST /api/session.rename — titles a session so it is findable in the
  /// web GUI's session list.
  func rename(sessionId: String, title: String, completion: @escaping (Result<Void, Error>) -> Void) {
    rpc("session.rename", ["sessionId": sessionId, "title": title]) { result in
      switch result {
      case .success: completion(.success(()))
      case .failure(let error): completion(.failure(error))
      }
    }
  }

  // MARK: Streaming downlink

  /// One live mux subscription. The bridge relays this WebSocket downlink-only:
  /// never send messages over it. Frames are parsed defensively — unknown
  /// frame types (projections, queues, other sessions) are ignored.
  final class MuxStream: NSObject, URLSessionWebSocketDelegate {
    var onDelta: ((String) -> Void)?
    var onTurnEnd: (() -> Void)?
    var onError: ((String) -> Void)?

    private var task: URLSessionWebSocketTask?
    private let queue = OperationQueue()

    func connect(sessionId: String) {
      guard let url = URL(string: "ws://127.0.0.1:3742/api/events.mux") else { return }
      let task = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: queue)
        .webSocketTask(with: url)
      task.resume()
      self.task = task
      receiveLoop(filter: sessionId)
    }

    func close() {
      task?.cancel(with: .goingAway, reason: nil)
      task = nil
      onDelta = nil
      onTurnEnd = nil
      onError = nil
    }

    private func receiveLoop(filter sessionId: String) {
      task?.receive { [weak self] result in
        guard let self, self.task != nil else { return }
        switch result {
        case .failure(let error):
          let handler = self.onError
          self.close()
          handler?("stream closed: \(error.localizedDescription)")
          return
        case .success(let frame):
          if case URLSessionWebSocketTask.Message.string(let text) = frame,
             let obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
            self.handle(raw: obj, sessionId: sessionId)
          }
          self.receiveLoop(filter: sessionId)
        }
      }
    }

    /// Mux frames arrive wrapped in `{type:"server-request", rpcId, payload}`
    /// envelopes; the payload carries the mux frame. Delta path:
    /// payload.type "session/event" → event.type "assistant/chunk" →
    /// data.chunk.type "text-delta" → chunk.text. "turn/end" completes.
    private func handle(raw: [String: Any], sessionId: String) {
      let obj = (raw["type"] as? String == "server-request"
        ? raw["payload"] as? [String: Any] : raw) ?? [:]
      guard obj["type"] as? String == "session/event", obj["sessionId"] as? String == sessionId,
            let event = obj["event"] as? [String: Any] else { return }
      switch event["type"] as? String {
      case "assistant/chunk":
        guard let chunk = (event["data"] as? [String: Any])?["chunk"] as? [String: Any],
              chunk["type"] as? String == "text-delta", let text = chunk["text"] as? String else { return }
        DispatchQueue.main.async { self.onDelta?(text) }
      case "turn/end":
        DispatchQueue.main.async { self.onTurnEnd?() }
      case "stream/error":
        let message = (event["data"] as? [String: Any])?["error"] as? String ?? "stream error"
        DispatchQueue.main.async { self.onError?(message) }
      default:
        break
      }
    }
  }
}

/// Desktop context v0: zero-permission signals prepended to each ask. The
/// frontmost app needs no consent; the browser URL uses AppleScript only when
/// automation consent already exists — one failure disables it for the
/// process lifetime so the user never sees a permission prompt storm.
enum DesktopContext {
  private static var browserScriptDisabled = false
  private static let browsers = ["Safari", "Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Firefox"]

  static func collect() -> String {
    var lines: [String] = []
    if let app = NSWorkspace.shared.frontmostApplication {
      lines.append("- Frontmost app: \(app.localizedName ?? "?") (\(app.bundleIdentifier ?? "?"))")
      if !browserScriptDisabled, let url = browserURL(appName: app.localizedName ?? "") {
        lines.append("- Browser URL: \(url)")
      }
    }
    guard !lines.isEmpty else { return "" }
    return "<desktop-context>\n" + lines.joined(separator: "\n") + "\n</desktop-context>\n\n"
  }

  private static func browserURL(appName: String) -> String? {
    guard browsers.contains(appName), let script = NSAppleScript(source: """
    tell application "\(appName)" to get URL of active tab of front window
    """) else { return nil }
    // executeAndReturnError never throws; an automation-consent denial shows
    // up in the returned error dictionary. Any failure disables the probe for
    // the process lifetime.
    var errorInfo: NSDictionary?
    let result = script.executeAndReturnError(&errorInfo)
    if errorInfo != nil {
      browserScriptDisabled = true
      return nil
    }
    return result.stringValue
  }
}

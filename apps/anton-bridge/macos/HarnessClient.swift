import Cocoa
import ScreenCaptureKit

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

/// Desktop context v1: zero-permission signals prepended to each ask, plus a
/// user-facing provenance line for the answer header ("Read: …"). The
/// frontmost app needs no consent; the browser URL uses AppleScript only when
/// automation consent already exists; the window title and selected text use
/// the Accessibility API only when accessibility trust already exists; the
/// screenshot is captured only when Screen Recording trust already exists
/// (the macOS dialog is requested at most once). Every consent-gated probe
/// self-disables on failure so the user never sees a prompt storm.
enum DesktopContext {
  /// What the ask read, phrased for the popup's answer header.
  struct Snapshot {
    let context: String
    let provenance: String?
  }

  private static var browserScriptDisabled = false
  private static var accessibilityDisabled = false
  private static var screenAccessRequested = false
  private static let browsers = ["Safari", "Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Firefox"]

  static func snapshot(prompt: String = "") -> Snapshot {
    var lines: [String] = []
    var provenanceParts: [String] = []
    if let app = NSWorkspace.shared.frontmostApplication {
      let appName = app.localizedName ?? "?"
      lines.append("- Frontmost app: \(appName) (\(app.bundleIdentifier ?? "?"))")
      provenanceParts.append(appName)
      if !accessibilityDisabled, let title = windowTitle(processId: app.processIdentifier) {
        lines.append("- Window title: \(title)")
        provenanceParts.append("“" + DesktopContext.truncate(title, 60) + "”")
      }
      // Selected text rides the same Accessibility trust as the title; an
      // app with no selection is normal, not a consent failure.
      if !accessibilityDisabled, let selection = selectedText(processId: app.processIdentifier) {
        lines.append("- Selected text: \(truncate(selection, 500))")
        provenanceParts.append("selection")
      }
      if !browserScriptDisabled, let url = browserURL(appName: appName) {
        lines.append("- Browser URL: \(url)")
        provenanceParts.append(url)
      }
    }
    if let shotPath = screenshotIfPermitted() {
      lines.append("- Screenshot saved at: \(shotPath) — read this file with the read_image tool to see the user's screen")
      provenanceParts.append("screenshot")
    }
    // Clipboard is strictly on demand: attached only when the question
    // refers to it, never as ambient capture.
    let asked = prompt.lowercased()
    if asked.contains("clipboard") || asked.contains("copied") || asked.contains("copy ") , let clip = clipboardText() {
      lines.append("- Clipboard text: \(truncate(clip, 500))")
      provenanceParts.append("clipboard")
    }
    let provenance = provenanceParts.isEmpty ? nil : provenanceParts.joined(separator: " — ")
    guard !lines.isEmpty else { return Snapshot(context: "", provenance: nil) }
    return Snapshot(context: "<desktop-context>\n" + lines.joined(separator: "\n") + "\n</desktop-context>\n\n",
                    provenance: provenance)
  }

  /// Convenience wrapper for callers that only need the prompt prefix.
  static func collect() -> String { snapshot().context }

  /// Truncate with an ellipsis for provenance display only; the model always
  /// receives the full line.
  private static func truncate(_ value: String, _ maxCount: Int) -> String {
    value.count > maxCount ? value.prefix(maxCount) + "…" : value
  }

  /// Selected text of the focused element via the Accessibility API. Trust
  /// failures (apiDisabled, cannotComplete) disable AX probes for the process
  /// lifetime; a missing selection is expected and silent.
  private static func selectedText(processId: pid_t) -> String? {
    let axApp = AXUIElementCreateApplication(processId)
    var elementRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &elementRef) == .success,
          elementRef != nil else {
      return nil
    }
    var textRef: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(elementRef as! AXUIElement, kAXSelectedTextAttribute as CFString, &textRef)
    if result == .apiDisabled || result == .cannotComplete {
      accessibilityDisabled = true
      return nil
    }
    guard let text = textRef as? String, !text.isEmpty else { return nil }
    return text
  }

  /// Clipboard text as plain string; nil when the pasteboard holds nothing
  /// readable as text.
  private static func clipboardText() -> String? {
    guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return nil }
    return text
  }

  /// Capture the frontmost window via ScreenCaptureKit to the Blueant
  /// attachments folder. The Screen Recording permission dialog is the
  /// approve-once gate: requested at most once per process lifetime; a
  /// denial means screenshots silently never appear. SCScreenshotManager is
  /// async, so the ask thread parks on a semaphore for the duration of one
  /// frame capture.
  private static func screenshotIfPermitted() -> String? {
    guard CGPreflightScreenCaptureAccess() else {
      if !screenAccessRequested {
        screenAccessRequested = true
        CGRequestScreenCaptureAccess()
      }
      return nil
    }
    if #unavailable(macOS 14.0) { return nil }
    var captured: CGImage?
    let done = DispatchSemaphore(value: 0)
    Task {
      defer { done.signal() }
      guard let app = NSWorkspace.shared.frontmostApplication else { return }
      guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
            let window = content.windows.first(where: {
              $0.owningApplication?.processID == app.processIdentifier && $0.frame.width > 200 && $0.frame.height > 100
            }) else { return }
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let config = SCStreamConfiguration()
      config.captureResolution = .best
      config.showsCursor = true
      captured = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }
    done.wait()
    guard let image = captured else { return nil }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Anton", isDirectory: true)
      .appendingPathComponent("blueant", isDirectory: true)
      .appendingPathComponent("attachments", isDirectory: true)
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let url = support.appendingPathComponent("ask-\(formatter.string(from: Date())).png")
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return url.path
  }

  /// Focused window title via the Accessibility API. Reads only the title of
  /// the already-focused window; when the app or the system has not granted
  /// accessibility trust the call fails and the probe disables itself.
  private static func windowTitle(processId: pid_t) -> String? {
    let axApp = AXUIElementCreateApplication(processId)
    var windowRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
          windowRef != nil else {
      return nil
    }
    var titleRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(windowRef as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success,
          let title = titleRef as? String, !title.isEmpty else {
      // An app that refuses the title read (or an untrusted process) should
      // not retry every ask; treat the failure like a consent denial.
      accessibilityDisabled = true
      return nil
    }
    return title
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

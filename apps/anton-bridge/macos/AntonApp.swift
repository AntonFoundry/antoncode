import Cocoa
import Security
import UserNotifications

@main
struct AntonMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AntonApp()
    app.delegate = delegate
    app.run()
  }
}

/// The menu-bar controller: it supervises the local bridge, reflects the
/// Harness state in the status item, escalates into the recovery profile when
/// the Harness will not stay up, presents Agent Mail consent prompts, and
/// delivers the notifications the agent queues through the bridge.
final class AntonApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private enum HarnessState {
    case running
    case transitioning
    case stopped
  }

  private struct BridgeStatus: Decodable {
    let harness: Harness
  }

  private struct Harness: Decodable {
    let running: Bool
  }

  private struct RecoveryState: Decodable {
    let repair: String
  }

  private struct NotifyPending: Decodable {
    let notifications: [Notification]
    struct Notification: Decodable {
      let id: String
      let title: String
      let body: String
    }
  }

  private var bridge: Process?
  private var nativeConsentSeed: Data?
  private var nativeConsentPanel: NativeConsentPanel?
  private var nativeConsentExpiresAt: Int64 = 0
  private var nativeConsentPolling = false
  private var statusItem: NSStatusItem?
  private var startItem: NSMenuItem?
  private var stopItem: NSMenuItem?
  private var restartItem: NSMenuItem?
  private var recoveryItem: NSMenuItem?
  private var pollTimer: Timer?
  private var harnessState: HarnessState = .transitioning
  private var consecutivePollFailures = 0
  // Watchdog: a harness that stays down without a user stop, or a bridge that
  // dies repeatedly, escalates into the recovery profile.
  private var recoveryMode = false
  private var terminatingBridge = false
  private var userStopped = false
  private var stoppedSince: Date?
  private var bridgeDeaths: [Date] = []
  private var recoveryUIOpened = false
  // The bridge listens on the loopback address it reports as `listening_on`.
  // Polling 127.0.0.1 (not the antoncode.localhost alias) keeps ATS and the
  // system resolver out of the status path entirely.
  private let bridgeURL = URL(string: "http://127.0.0.1:3742")!

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Single instance: a second launch (double-open, script launching the
    // binary directly after a failed `open`) would register a duplicate
    // status item. The first instance wins; this one exits before installing
    // any UI or the bridge.
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.antoncode.anton")
      .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    if let existing = others.first {
      NSLog("Anton: instance already running (pid \(existing.processIdentifier)) — exiting")
      exit(0)
    }
    NSApp.setActivationPolicy(.accessory)
    installMenu()
    launchBridge()
    beginStatusPolling()
  }

  func applicationWillTerminate(_ notification: Notification) {
    pollTimer?.invalidate()
    nativeConsentPanel?.close()
    nativeConsentPanel = nil
    nativeConsentSeed = nil
    terminatingBridge = true
    bridge?.terminate()
  }

  private func launchBridge(profile bridgeProfile: String = "web") {
    guard let resources = Bundle.main.resourceURL else { return }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Anton", isDirectory: true)
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)

    let process = Process()
    process.executableURL = resources.appendingPathComponent("bin/anton-bridge")
    var environment = ProcessInfo.processInfo.environment
    environment["ANTON_DSH_ROOT"] = resources.appendingPathComponent("deepseek-harness").path
    environment["ANTON_CONTEXT_PLUGIN_ROOT"] = resources
      .appendingPathComponent("c0ntext/deepseek-harness-plugin").path
    environment["ANTON_DSH_HOME"] = support.appendingPathComponent("dsh").path
    environment["ANTON_BRIDGE_CONFIG"] = support.appendingPathComponent("bridge.json").path
    environment["ANTON_NODE_BINARY"] = resources.appendingPathComponent("node/bin/node").path
    environment["ANTON_DSH_PROFILE"] = bridgeProfile
    process.environment = environment
    // The bridge authorization key must never enter argv, environment or a log:
    // same-user processes can inspect those surfaces. The anonymous pipe is
    // written once by the native app and then closed, including on spawn error.
    var consentKey = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, consentKey.count, &consentKey) == errSecSuccess else {
      showError("Anton could not create its private consent channel.")
      return
    }
    let keyPipe = Pipe()
    process.standardInput = keyPipe
    let seed = Data(consentKey)
    let keyLine = seed.base64EncodedString() + "\n"
    let logURL = support.appendingPathComponent("bridge.log")
    // Append across launches: the output of the bridge that just died is the
    // only record of why it died, and a relaunch must not be what destroys it.
    // `createFile(atPath:contents:)` replaces an existing file, so creating it
    // unconditionally truncated the log on every launch and left the
    // `seekToEnd()` below with nothing to seek past. Entering recovery is
    // itself a relaunch, so that wiped the crash evidence moments before the
    // bridge spawned the repair agent whose first instruction is to read this
    // file — every automatic repair turn opened on an empty log.
    //
    // Rotating one generation at a size cap keeps an unbounded append from
    // growing the log without limit, while still leaving the previous
    // episode's tail on disk for the next diagnosis.
    let manager = FileManager.default
    if let size = try? manager.attributesOfItem(atPath: logURL.path)[.size] as? UInt64,
       size > 4 * 1024 * 1024 {
      let rotatedURL = support.appendingPathComponent("bridge.log.1")
      try? manager.removeItem(at: rotatedURL)
      try? manager.moveItem(at: logURL, to: rotatedURL)
    }
    if !manager.fileExists(atPath: logURL.path) {
      manager.createFile(atPath: logURL.path, contents: nil)
    }
    if let log = try? FileHandle(forWritingTo: logURL) {
      _ = try? log.seekToEnd()
      process.standardOutput = log
      process.standardError = log
    }
    process.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async { self?.bridgeExited(finished) }
    }
    do {
      try process.run()
      defer { try? keyPipe.fileHandleForWriting.close() }
      keyPipe.fileHandleForWriting.write(Data(keyLine.utf8))
      nativeConsentPanel?.close()
      nativeConsentPanel = nil
      nativeConsentSeed = seed
      bridge = process
    } catch {
      nativeConsentSeed = nil
      try? keyPipe.fileHandleForWriting.close()
      showError("Anton could not start its local bridge: \(error.localizedDescription)")
    }
  }

  /// The bridge died on its own: relaunch it on the same profile, escalating
  /// to recovery after repeated rapid deaths.
  ///
  /// Identity, not a flag, decides whether this death is ours to act on.
  /// `Process.terminate()` is asynchronous, so a deliberate swap's handler
  /// lands well after `swapBridge` has already installed the replacement; a
  /// `terminatingBridge` flag cleared synchronously is always back to `false`
  /// by then. Comparing against the current `bridge` makes a superseded
  /// process exit silently, which keeps a swap from being counted as a crash,
  /// from orphaning the live bridge's handle, and from racing a second
  /// instance onto the same port.
  private func bridgeExited(_ finished: Process) {
    guard !terminatingBridge, bridge === finished else { return }
    nativeConsentSeed = nil
    nativeConsentPanel?.close()
    nativeConsentPanel = nil
    bridge = nil
    bridgeDeaths.append(Date())
    bridgeDeaths.removeAll { Date().timeIntervalSince($0) > 300 }
    if !recoveryMode && bridgeDeaths.count >= 3 {
      enterRecovery()
      return
    }
    setHarnessState(.transitioning)
    // A bridge that dies on startup (port still held, bad profile) would
    // otherwise respawn as fast as the CPU allows. Back off on consecutive
    // deaths so the loop stays observable and the log stays readable.
    let delay = min(pow(2.0, Double(bridgeDeaths.count)), 30.0)
    let profile = recoveryMode ? "recovery" : "web"
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.bridge == nil, !self.terminatingBridge else { return }
      self.launchBridge(profile: profile)
    }
  }

  /// Last time the browser surface was opened, used to collapse bursts.
  private var lastOpenedAnton: Date?

  /// Open the bridge's web surface, at most once every few seconds, reporting
  /// whether the tab was actually opened.
  ///
  /// Every automatic caller here is state-driven (a recovery episode reaching
  /// `.running`, a start/restart the bridge accepted), so a state machine that
  /// flaps turns directly into a pile of browser tabs. The throttle keeps a
  /// flap costing a wrong state instead of an unusable browser. Callers that
  /// latch a "surface shown" flag must latch it on the returned value, or a
  /// throttled call would leave the flag set with no window on screen.
  @discardableResult
  private func openAntonSurface() -> Bool {
    if let last = lastOpenedAnton, Date().timeIntervalSince(last) < 5 { return false }
    lastOpenedAnton = Date()
    NSWorkspace.shared.open(bridgeURL)
    return true
  }

  /// Menu target. A deliberate click is always honoured: the user asking for
  /// the window twice is not the flap the throttle exists to absorb.
  @objc private func openAnton() {
    lastOpenedAnton = Date()
    NSWorkspace.shared.open(bridgeURL)
  }

  @objc private func startHarness() {
    userStopped = false
    requestHarness("start", successState: .running, openAfterSuccess: true)
  }

  @objc private func stopHarness() {
    userStopped = true
    requestHarness("stop", successState: .stopped)
  }

  /// Restart the Harness through the bridge, matching `anton status`.
  /// The tray and bridge remain alive while the managed Harness child is
  /// replaced, so every normal runtime restart uses the same path.
  @objc private func restartAnton() {
    userStopped = false
    requestHarness("restart", successState: .running, openAfterSuccess: true)
  }

  private func requestHarness(_ action: String, successState: HarnessState, openAfterSuccess: Bool = false) {
    setHarnessState(.transitioning)
    var request = URLRequest(url: bridgeURL.appendingPathComponent("bridge/api/harness/\(action)"))
    request.httpMethod = "POST"
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
          self.refreshHarnessState()
          return
        }
        self.setHarnessState(successState)
        self.refreshHarnessState()
        if openAfterSuccess {
          // A menu always dismisses after its action. Opening the browser only
          // after the bridge accepted the health-checked start makes Start
          // Harness feel like a real launch rather than a transient icon flash.
          self.openAntonSurface()
        }
      }
    }.resume()
  }

  @objc private func openBridgeLog() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Anton/bridge.log")
    NSWorkspace.shared.open(support)
  }

  /// In recovery mode, watch the bridge's repair turn: when it completes,
  /// swap back onto the main profile automatically — the loop closes without
  /// a human. A failed turn stays in recovery for the user to take over.
  private func pollRecoveryState() {
    guard recoveryMode else { return }
    let stateURL = bridgeURL.appendingPathComponent("bridge/api/recovery/state")
    URLSession.shared.dataTask(with: stateURL) { [weak self] data, response, _ in
      guard let self, let data, let response = response as? HTTPURLResponse,
            (200..<300).contains(response.statusCode) else { return }
      guard let state = try? JSONDecoder().decode(RecoveryState.self, from: data) else { return }
      DispatchQueue.main.async {
        if state.repair == "done" && self.recoveryMode { self.exitRecovery() }
      }
    }.resume()
  }

  private func beginStatusPolling() {
    refreshHarnessState()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      self?.refreshHarnessState()
      self?.pollRecoveryState()
      self?.pollNotifications()
      self?.pollNativeConsent()
    }
  }

  /// Polling carries a one-use HMAC over a fresh nonce. Browser requests,
  /// including same-origin loopback traffic, cannot dequeue a challenge.
  private func pollNativeConsent() {
    guard !recoveryMode, !nativeConsentPolling, let seed = nativeConsentSeed, let activeBridge = bridge else { return }
    if nativeConsentExpiresAt > 0, Int64(Date().timeIntervalSince1970 * 1000) >= nativeConsentExpiresAt {
      nativeConsentPanel?.close()
      nativeConsentPanel = nil
      nativeConsentExpiresAt = 0
    }
    let timestamp = String(Int64(Date().timeIntervalSince1970 * 1000))
    var nonceBytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, nonceBytes.count, &nonceBytes) == errSecSuccess else { return }
    let nonce = nonceBytes.map { String(format: "%02x", $0) }.joined()
    guard let mac = NativeConsentCode.mac(seed: seed, fields: ["antonmail-native-poll-v1", timestamp, nonce]) else { return }
    var request = URLRequest(url: bridgeURL.appendingPathComponent("bridge/api/mail/native-pending"))
    request.timeoutInterval = 5
    request.setValue(timestamp, forHTTPHeaderField: "x-anton-mail-time")
    request.setValue(nonce, forHTTPHeaderField: "x-anton-mail-nonce")
    request.setValue(mac, forHTTPHeaderField: "x-anton-mail-mac")
    nativeConsentPolling = true
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.nativeConsentPolling = false
        guard self.bridge === activeBridge, self.nativeConsentSeed == seed,
              let response = response as? HTTPURLResponse, response.statusCode == 200,
              let data, data.count <= 2048,
              let challenge = try? JSONDecoder().decode(NativeConsentChallenge.self, from: data) else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard challenge.expiresAt > now, challenge.expiresAt <= now + 90_000,
              challenge.summary.utf8.count <= 512,
              let code = NativeConsentCode.derive(seed: seed, challenge: challenge) else { return }
        self.nativeConsentPanel?.close()
        let panel = NativeConsentPanel(challenge: challenge, code: code)
        self.nativeConsentPanel = panel
        self.nativeConsentExpiresAt = challenge.expiresAt
        panel.orderFrontRegardless()
      }
    }.resume()
  }

  /// Notification delivery: pull what the bridge inbox queued (the agent's
  /// `notify` tool and any loopback caller), present each through
  /// UNUserNotificationCenter, and ack by id so the bridge queue drains.
  /// Delivery is once-per-id: poll cycles overlap (the first one parks on
  /// the authorization dialog), so ids are claimed on the main queue before
  /// delivery and an already-claimed id is skipped and acked.
  /// Notification authorization is requested lazily on the first delivery —
  /// the macOS permission dialog is the approve-once gate.
  private func pollNotifications() {
    guard !recoveryMode else { return }
    let url = bridgeURL.appendingPathComponent("bridge/api/notify/pending")
    URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
      guard let self, let data, let response = response as? HTTPURLResponse,
            (200..<300).contains(response.statusCode) else { return }
      guard let pending = try? JSONDecoder().decode(NotifyPending.self, from: data), !pending.notifications.isEmpty else { return }
      DispatchQueue.main.async {
        // Claim ids synchronously so overlapping poll cycles see each
        // other's claims; anything new is delivered, anything already
        // claimed is just acked off the queue.
        let freshIds = Set(pending.notifications.map(\.id)).subtracting(self.claimedNotificationIds)
        let fresh = pending.notifications.filter { freshIds.contains($0.id) }
        self.ackNotifications(pending.notifications.map(\.id))
        guard !fresh.isEmpty else { return }
        self.claimedNotificationIds.formUnion(Set(fresh.map(\.id)))
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
          guard granted else { return }
          center.delegate = self.notificationDelegate
          for note in fresh {
            let content = UNMutableNotificationContent()
            content.title = note.title
            content.body = note.body
            let request = UNNotificationRequest(identifier: note.id, content: content, trigger: nil)
            center.add(request) { _ in }
          }
        }
      }
    }.resume()
  }

  /// Ids already claimed for delivery or ack by a previous poll cycle.
  private var claimedNotificationIds = Set<String>()

  private func ackNotifications(_ ids: [String]) {
    guard !ids.isEmpty, let payload = try? JSONSerialization.data(withJSONObject: ["ids": ids]) else { return }
    var request = URLRequest(url: bridgeURL.appendingPathComponent("bridge/api/notify/ack"))
    request.httpMethod = "POST"
    request.httpBody = payload
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    URLSession.shared.dataTask(with: request).resume()
  }

  /// Foreground presentation: Anton is an accessory app; its notifications
  /// must be visible even while the user is working elsewhere in it.
  private lazy var notificationDelegate: NotificationDelegate = NotificationDelegate()

  private func refreshHarnessState() {
    let statusURL = bridgeURL.appendingPathComponent("bridge/api/status")
    URLSession.shared.dataTask(with: statusURL) { [weak self] data, response, _ in
      guard let self, let data, let response = response as? HTTPURLResponse,
            (200..<300).contains(response.statusCode), let status = try? JSONDecoder().decode(BridgeStatus.self, from: data) else {
        DispatchQueue.main.async {
          guard let self else { return }
          // One failed poll never flips a running Harness to stopped: the
          // bridge briefly drops connections while the Harness restarts.
          self.consecutivePollFailures += 1
          if self.consecutivePollFailures >= 3 {
            self.setHarnessState(.stopped)
          }
        }
        return
      }
      DispatchQueue.main.async {
        self.consecutivePollFailures = 0
        self.setHarnessState(status.harness.running ? .running : .stopped)
        self.evaluateEscalation()
      }
    }.resume()
  }

  /// Escalate to the recovery profile when the harness stays down longer than
  /// a deliberate stop explains. A user stop never escalates on its own; only
  /// a crash-looping harness or bridge does.
  private func evaluateEscalation() {
    if harnessState == .running {
      stoppedSince = nil
      return
    }
    if harnessState == .stopped && stoppedSince == nil && !userStopped {
      stoppedSince = Date()
    }
    guard !recoveryMode, !userStopped, let since = stoppedSince,
          Date().timeIntervalSince(since) > 60 else { return }
    enterRecovery()
  }

  /// Swap the bridge onto the first-party-only recovery profile and open its
  /// web UI — the place where a broken main profile gets repaired.
  private func enterRecovery() {
    recoveryMode = true
    stoppedSince = nil
    recoveryUIOpened = false
    // The deaths that justified this escalation have been acted on. Leaving
    // them in the window would re-trigger the escalation the moment recovery
    // is left, which is what made recovery mode inescapable.
    bridgeDeaths.removeAll()
    swapBridge(profile: "recovery")
  }

  @objc private func exitRecovery() {
    recoveryMode = false
    userStopped = false
    stoppedSince = nil
    bridgeDeaths.removeAll()
    swapBridge(profile: "web")
  }

  /// Replace the running bridge with one on a different profile. The outgoing
  /// process is released before the replacement starts; its late
  /// `terminationHandler` is discarded by the identity guard in
  /// `bridgeExited(_:)` rather than by a flag that cannot outlive this call.
  private func swapBridge(profile: String) {
    nativeConsentPanel?.close()
    nativeConsentPanel = nil
    nativeConsentSeed = nil
    nativeConsentExpiresAt = 0
    bridge?.terminate()
    bridge = nil
    setHarnessState(.transitioning)
    launchBridge(profile: profile)
  }

  private func setHarnessState(_ state: HarnessState) {
    harnessState = state
    updatePresentation()
    if recoveryMode && state == .running && !recoveryUIOpened {
      recoveryUIOpened = openAntonSurface()
    }
  }

  /// The Anton graph mark: three linked nodes, the same glyph the web UI uses
  /// for the collapsed context-map toggle (viewBox 0 0 20 20). Drawn as a
  /// template image so the system tints it on light and dark menu bars.
  private func antonMarkImage() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
      let scale = rect.width / 20
      NSColor.black.set()
      let edges = NSBezierPath()
      edges.lineWidth = 1.6 * scale
      edges.lineCapStyle = .round
      edges.move(to: NSPoint(x: 6.8 * scale, y: 7.3 * scale))
      edges.line(to: NSPoint(x: 8.8 * scale, y: 11.6 * scale))
      edges.move(to: NSPoint(x: 12.8 * scale, y: 7 * scale))
      edges.line(to: NSPoint(x: 11.2 * scale, y: 11.4 * scale))
      edges.move(to: NSPoint(x: 7 * scale, y: 6.2 * scale))
      edges.line(to: NSPoint(x: 12.2 * scale, y: 6.2 * scale))
      edges.stroke()
      for (cx, cy, r) in [(5.0, 6.0, 2.2), (14.5, 5.5, 2.2), (10.0, 14.0, 2.5)] {
        NSBezierPath(ovalIn: NSRect(x: (cx - r) * scale, y: (cy - r) * scale, width: 2 * r * scale, height: 2 * r * scale)).fill()
      }
      return true
    }
    image.isTemplate = true
    return image
  }

  private func updatePresentation() {
    startItem?.isEnabled = harnessState == .stopped
    stopItem?.isEnabled = harnessState == .running
    restartItem?.isEnabled = harnessState != .transitioning
    recoveryItem?.isHidden = !recoveryMode
    let tint: NSColor?
    let background: NSColor
    let label: String
    switch harnessState {
    case .running:
      // Explicit state chip: white mark on a green rounded square; amber
      // while the recovery profile carries the surface.
      tint = .white
      background = recoveryMode ? .systemYellow : .systemGreen
      label = recoveryMode ? "Anton: recovery mode" : "Anton: Harness running"
    case .transitioning:
      tint = .white
      background = .systemOrange
      label = "Anton: Harness starting or stopping"
    case .stopped:
      // Stopped uses the default menu-bar styling: the template mark tinted
      // by the system, which stays legible on light and dark menu bars.
      tint = nil
      background = .clear
      label = "Anton: Harness stopped"
    }
    statusItem?.button?.image = antonMarkImage()
    statusItem?.button?.contentTintColor = tint
    statusItem?.button?.layer?.backgroundColor = background.cgColor
    statusItem?.button?.toolTip = label
  }

  func menuWillOpen(_ menu: NSMenu) {
    refreshHarnessState()
  }

  @objc private func quitAnton() {
    NSApp.terminate(nil)
  }

  private func showError(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Anton"
    alert.informativeText = message
    alert.runModal()
  }

  private func installMenu() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.toolTip = "Anton: checking Harness status"
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    menu.addItem(NSMenuItem(title: "Open Anton", action: #selector(openAnton), keyEquivalent: "o"))
    let start = NSMenuItem(title: "Start Harness", action: #selector(startHarness), keyEquivalent: "s")
    start.target = self
    menu.addItem(start)
    let stop = NSMenuItem(title: "Stop Harness", action: #selector(stopHarness), keyEquivalent: "")
    stop.target = self
    menu.addItem(stop)
    let restart = NSMenuItem(title: "Restart", action: #selector(restartAnton), keyEquivalent: "r")
    restart.target = self
    menu.addItem(restart)
    let exitRecoveryItem = NSMenuItem(title: "Exit Recovery Mode", action: #selector(exitRecovery), keyEquivalent: "")
    exitRecoveryItem.target = self
    menu.addItem(exitRecoveryItem)
    recoveryItem = exitRecoveryItem
    let openLog = NSMenuItem(title: "Open bridge.log", action: #selector(openBridgeLog), keyEquivalent: "")
    openLog.target = self
    menu.addItem(openLog)
    menu.addItem(NSMenuItem.separator())
    let quit = NSMenuItem(title: "Quit Anton", action: #selector(quitAnton), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    item.menu = menu
    item.button?.wantsLayer = true
    item.button?.layer?.cornerRadius = 8
    item.button?.layer?.masksToBounds = true
    statusItem = item
    startItem = start
    stopItem = stop
    restartItem = restart
    updatePresentation()
  }
}

/// Presents agent notifications even when the app is frontmost; without this
/// delegate macOS silently drops banners for accessory apps in the foreground.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(_ center: UNUserNotificationCenter,
                              willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }
}

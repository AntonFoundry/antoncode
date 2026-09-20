import Cocoa

@main
struct AntonMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AntonApp()
    app.delegate = delegate
    app.run()
  }
}

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

  private var bridge: Process?
  private var statusItem: NSStatusItem?
  private var startItem: NSMenuItem?
  private var stopItem: NSMenuItem?
  private var restartItem: NSMenuItem?
  private var pollTimer: Timer?
  private var harnessState: HarnessState = .transitioning
  private var consecutivePollFailures = 0
  private var blueantPanel: BlueantPanel?
  private var hotkeyCenter: HotkeyCenter?
  // The bridge listens on the loopback address it reports as `listening_on`.
  // Polling 127.0.0.1 (not the antoncode.localhost alias) keeps ATS and the
  // system resolver out of the status path entirely.
  private let bridgeURL = URL(string: "http://127.0.0.1:3742")!

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Single instance: a second launch (double-open, script launching the
    // binary directly after a failed `open`) would register a duplicate
    // status item and a duplicate hotkey. The first instance wins; this one
    // exits before installing any UI or the bridge.
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.antoncode.anton")
      .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    if let existing = others.first {
      NSLog("Anton: instance already running (pid \(existing.processIdentifier)) — exiting")
      exit(0)
    }
    NSApp.setActivationPolicy(.accessory)
    installMenu()
    installBlueant()
    launchBridge()
    beginStatusPolling()
  }

  func applicationWillTerminate(_ notification: Notification) {
    pollTimer?.invalidate()
    hotkeyCenter?.unregister()
    bridge?.terminate()
  }

  /// Blueant popup: menu item toggles the panel; ⇧⌥Space toggles it from
  /// anywhere. A failed hotkey registration only costs the shortcut.
  private func installBlueant() {
    let panel = BlueantPanel()
    blueantPanel = panel
    let center = HotkeyCenter()
    center.register { [weak panel] in panel?.toggle() }
    hotkeyCenter = center
  }

  private func installMenu() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.toolTip = "Anton: checking Harness status"
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    let blueant = NSMenuItem(title: "Open Blueant", action: #selector(toggleBlueant), keyEquivalent: "b")
    blueant.target = self
    menu.addItem(blueant)
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

  private func launchBridge() {
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
    process.environment = environment
    let logURL = support.appendingPathComponent("bridge.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    if let log = try? FileHandle(forWritingTo: logURL) {
      _ = try? log.seekToEnd()
      process.standardOutput = log
      process.standardError = log
    }
    do {
      try process.run()
      bridge = process
    } catch {
      showError("Anton could not start its local bridge: \(error.localizedDescription)")
    }
  }

  @objc private func openAnton() {
    NSWorkspace.shared.open(bridgeURL)
  }

  @objc private func toggleBlueant() {
    guard let panel = blueantPanel else { return }
    if !panel.isVisible {
      // Fresh opens anchor under the status item.
      panel.positionUnder(anchorRect: nil)
    }
    panel.toggle()
  }

  @objc private func startHarness() {
    requestHarness("start", successState: .running, openAfterSuccess: true)
  }

  @objc private func stopHarness() {
    requestHarness("stop", successState: .stopped)
  }

  /// Restart the whole Anton stack (Harness → bridge → tray). Spawns a
  /// detached relauncher so it survives this instance terminating, then quits
  /// cleanly; the cascade (Swift → bridge SIGTERM → harness stop) shuts down
  /// before the relauncher reopens the app.
  @objc private func restartAnton() {
    let bundle = Bundle.main.bundleURL
    let relauncher = Process()
    relauncher.executableURL = URL(fileURLWithPath: "/bin/sh")
    relauncher.arguments = ["-c", "sleep 2; open \"\(bundle.path)\""]
    do {
      try relauncher.run()
    } catch {
      showError("Anton could not schedule a restart: \(error.localizedDescription)")
      return
    }
    NSApp.terminate(nil)
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
          self.openAnton()
        }
      }
    }.resume()
  }

  private func beginStatusPolling() {
    refreshHarnessState()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      self?.refreshHarnessState()
    }
  }

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
      }
    }.resume()
  }

  private func setHarnessState(_ state: HarnessState) {
    harnessState = state
    updatePresentation()
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
    let tint: NSColor?
    let background: NSColor
    let label: String
    switch harnessState {
    case .running:
      // Explicit state chip: white mark on a green rounded square.
      tint = .white
      background = .systemGreen
      label = "Anton: Harness running"
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
}

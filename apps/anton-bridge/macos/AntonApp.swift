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

/// Presentation selected for the short wake acknowledgement.
enum WakeIndicatorStyle {
  case notification
  case spectrum
  case orb
}

/// Floating acknowledgement shown while Blueant handles a wake-word request.
final class WakeIndicatorPanel: NSPanel {
  private let indicatorView = WakeIndicatorView(frame: .zero)
  var onClose: (() -> Void)? {
    didSet { indicatorView.onClose = onClose }
  }

  init() {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 140),
               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    level = .floating
    isOpaque = false
    backgroundColor = .clear
    ignoresMouseEvents = false
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    alphaValue = 0.94
    contentView = indicatorView
  }

  required init?(coder: NSCoder) { nil }

  func show(style: WakeIndicatorStyle) {
    indicatorView.style = style
    indicatorView.resetAudioLevel()
    indicatorView.needsDisplay = true
    switch style {
    case .orb:
      setContentSize(NSSize(width: 220, height: 220))
    case .notification, .spectrum:
      setContentSize(NSSize(width: 420, height: 178))
    }
    guard let screen = NSScreen.main else { return }
    let visible = screen.visibleFrame
    let size = frame.size
    let origin: NSPoint
    switch style {
    case .notification:
      fallthrough
    case .spectrum:
      origin = NSPoint(x: visible.maxX - size.width - 22, y: visible.maxY - size.height - 22)
    case .orb:
      origin = NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2)
    }
    setFrameOrigin(origin)
    alphaValue = 0
    orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.16
      animator().alphaValue = 1
    }
  }

  func updateLive(status: String, text: String?) {
    indicatorView.liveStatus = status
    if let text {
      indicatorView.liveText = String(text.suffix(360))
    }
    indicatorView.needsDisplay = true
    if !isVisible { orderFrontRegardless() }
  }

  func hide() {
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.12
      animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      self?.indicatorView.liveText = ""
      self?.indicatorView.liveStatus = "Listening…"
      self?.orderOut(nil)
    })
  }

  func setAudioLevel(_ level: Float) {
    indicatorView.setAudioLevel(level)
  }

  func setSpectrum(_ bands: [Float]) {
    indicatorView.setSpectrum(bands)
  }
}

private final class WakeIndicatorView: NSView {
  var onClose: (() -> Void)?
  var style: WakeIndicatorStyle = .notification
  var audioLevel: CGFloat = 0
  var liveText = ""
  var liveStatus = "Listening…"
  private var phase: CGFloat = 0
  private var targetAudioLevel: CGFloat = 0
  private var spectrum = [CGFloat](repeating: 0, count: 50)
  private var targetSpectrum = [CGFloat](repeating: 0, count: 50)
  private var timer: Timer?
  private let closeButton = NSButton()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close Blueant")
    closeButton.imagePosition = .imageOnly
    closeButton.isBordered = false
    closeButton.bezelStyle = .accessoryBarAction
    closeButton.contentTintColor = .secondaryLabelColor
    closeButton.toolTip = "End Blueant conversation"
    closeButton.target = self
    closeButton.action = #selector(closeConversation)
    addSubview(closeButton)
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    closeButton.frame = NSRect(x: bounds.maxX - 32, y: 8, width: 20, height: 20)
  }

  @objc private func closeConversation() { onClose?() }

  func setAudioLevel(_ decibels: Float) {
    let normalized = max(0, min(1, CGFloat((decibels + 62) / 30)))
    targetAudioLevel = pow(normalized, 0.62)
    needsDisplay = true
  }

  func resetAudioLevel() {
    targetAudioLevel = 0
    audioLevel = 0
    targetSpectrum = [CGFloat](repeating: 0, count: 50)
    spectrum = targetSpectrum
  }

  func setSpectrum(_ bands: [Float]) {
    targetSpectrum = (0..<50).map { index in
      CGFloat(index < bands.count ? max(0, min(1, bands[index])) : 0)
    }
    needsDisplay = true
  }

  override var isFlipped: Bool { true }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    timer?.invalidate()
    timer = window == nil ? nil : Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.phase += 0.075
      let response: CGFloat = self.targetAudioLevel > self.audioLevel ? 0.58 : 0.22
      self.audioLevel += (self.targetAudioLevel - self.audioLevel) * response
      for index in self.spectrum.indices {
        let bandResponse: CGFloat = self.targetSpectrum[index] > self.spectrum[index] ? 0.62 : 0.24
        self.spectrum[index] += (self.targetSpectrum[index] - self.spectrum[index]) * bandResponse
      }
      self.needsDisplay = true
    }
  }

  deinit { timer?.invalidate() }

  override func draw(_ dirtyRect: NSRect) {
    guard NSGraphicsContext.current != nil else { return }
    let bounds = self.bounds
    switch style {
    case .notification:
      drawPanelBackground(in: bounds)
      drawText("Blueant", at: NSPoint(x: bounds.midX - 28, y: 10), size: 16, color: .white)
      drawWaveforms(in: NSRect(x: 16, y: 34, width: bounds.width - 32, height: 104))
      drawLiveText(in: bounds)
    case .spectrum:
      drawPanelBackground(in: bounds)
      drawText("Blueant", at: NSPoint(x: bounds.midX - 28, y: 10), size: 16, color: .white)
      drawSpectrum(in: NSRect(x: 18, y: 42, width: bounds.width - 36, height: 62))
      drawLiveText(in: bounds)
    case .orb:
      drawOrb(in: bounds)
    }
  }

  private func drawPanelBackground(in bounds: NSRect) {
    let path = NSBezierPath(roundedRect: bounds, xRadius: 18, yRadius: 18)
    NSColor(calibratedWhite: 0.08, alpha: 0.54).setFill()
    path.fill()
    NSColor.white.withAlphaComponent(0.09).setStroke()
    path.lineWidth = 1
    path.stroke()
  }

  private func drawLiveText(in bounds: NSRect) {
    let statusY = bounds.maxY - 25
    if liveText.isEmpty {
      drawText(liveStatus, at: NSPoint(x: bounds.midX - 28, y: statusY), size: 11, color: .secondaryLabelColor)
      return
    }
    let responseRect = NSRect(x: 26, y: 112, width: bounds.width - 52, height: 31)
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    style.lineBreakMode = .byTruncatingTail
    (liveText as NSString).draw(in: responseRect, withAttributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .regular),
      .foregroundColor: NSColor.labelColor,
      .paragraphStyle: style,
    ])
    drawText(liveStatus, at: NSPoint(x: bounds.midX - 28, y: statusY), size: 11, color: .secondaryLabelColor)
  }

  /// Draws overlapping, sound-driven wave packets with tapered ends and
  /// translucent colored lobes.
  private func drawWaveforms(in rect: NSRect) {
    let gradientStops: [(NSColor, CGFloat)] = [
      (NSColor(calibratedRed: 0.98, green: 0.22, blue: 0.48, alpha: 1), 0.00),
      (NSColor(calibratedRed: 0.72, green: 0.23, blue: 0.95, alpha: 1), 0.32),
      (NSColor(calibratedRed: 0.20, green: 0.72, blue: 0.98, alpha: 1), 0.67),
      (NSColor(calibratedRed: 0.25, green: 0.94, blue: 0.72, alpha: 1), 1.00),
    ]
    let lobes: [[(CGFloat, CGFloat)]] = [
      [(0.13, 0.20), (0.29, 0.38), (0.47, 0.66), (0.64, 0.40), (0.82, 0.23)],
      [(0.16, 0.24), (0.34, 0.43), (0.53, 0.70), (0.70, 0.34), (0.86, 0.17)],
      [(0.12, 0.16), (0.31, 0.34), (0.49, 0.60), (0.68, 0.45), (0.84, 0.20)],
      [(0.15, 0.21), (0.36, 0.42), (0.56, 0.62), (0.73, 0.38), (0.89, 0.14)],
      [(0.18, 0.16), (0.38, 0.36), (0.51, 0.68), (0.66, 0.42), (0.83, 0.18)],
      [(0.14, 0.18), (0.32, 0.40), (0.46, 0.58), (0.62, 0.46), (0.87, 0.16)],
    ]
    let frequencies: [Double] = [3.1, 3.45, 3.8, 4.15, 4.5, 4.85]
    let layerScales: [CGFloat] = [0.76, 0.90, 1.0, 0.92, 0.80, 0.68]
    let layerAlphas: [CGFloat] = [0.20, 0.24, 0.32, 0.27, 0.22, 0.18]
    let quietAmplitude: CGFloat = 7.0
    let speechAmplitude = rect.height * (0.26 + audioLevel * 0.46)
    let samples = 240

    for index in lobes.indices {
      let path = NSBezierPath()
      let center = rect.midY
      let frequency = frequencies[index]
      var upper: [NSPoint] = []
      var lower: [NSPoint] = []
      for sample in 0...samples {
        let progress = CGFloat(sample) / CGFloat(samples)
        let x = rect.minX + progress * rect.width
        let spectrumIndex = min(spectrum.count - 1, Int(progress * CGFloat(spectrum.count)))
        let frequencyEnergy = spectrum[spectrumIndex]
        var envelope: CGFloat = 0
        for (lobeIndex, lobe) in lobes[index].enumerated() {
          let (position, weight) = lobe
          let drift = CGFloat(sin(Double(phase) * 0.22 + Double(lobeIndex) * 1.37 + Double(index))) * 0.012
          let width: CGFloat = lobeIndex == 2 ? 0.115 : 0.092
          let distance = (progress - position - drift) / width
          envelope += weight * CGFloat(exp(-Double(distance * distance) * 0.5))
        }
        let edgeTaper = pow(max(0, CGFloat(sin(Double(progress) * .pi))), 0.62)
        let oscillation = 0.28 + 0.72 * abs(CGFloat(sin(Double(progress) * .pi * frequency * 2
                                                            + Double(phase) * (0.7 + Double(index) * 0.13))))
        let localAmplitude = quietAmplitude + speechAmplitude * (0.58 + frequencyEnergy * 2.2) * layerScales[index]
        let height = min(rect.height * 0.46,
                         localAmplitude * min(1, envelope) * edgeTaper * oscillation)
        upper.append(NSPoint(x: x, y: center - height))
        lower.append(NSPoint(x: x, y: center + height))
      }
      path.move(to: upper[0])
      for point in upper.dropFirst() { path.line(to: point) }
      for point in lower.reversed() { path.line(to: point) }
      path.close()
      let alpha = layerAlphas[index]
      let gradient = NSGradient(colorsAndLocations:
        (gradientStops[0].0.withAlphaComponent(alpha), gradientStops[0].1),
        (gradientStops[1].0.withAlphaComponent(alpha), gradientStops[1].1),
        (gradientStops[2].0.withAlphaComponent(alpha), gradientStops[2].1),
        (gradientStops[3].0.withAlphaComponent(alpha), gradientStops[3].1))
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current?.compositingOperation = .screen
      path.addClip()
      gradient?.draw(in: rect, angle: 0)
      NSGraphicsContext.restoreGraphicsState()
    }

    let core = NSRect(x: rect.minX, y: rect.midY - 0.7, width: rect.width, height: 1.4)
    let coreGradient = NSGradient(colorsAndLocations:
      (NSColor.white.withAlphaComponent(0.08), 0.00),
      (NSColor.white.withAlphaComponent(0.42), 0.18),
      (NSColor.white.withAlphaComponent(0.94), 0.50),
      (NSColor.white.withAlphaComponent(0.42), 0.82),
      (NSColor.white.withAlphaComponent(0.08), 1.00))
    NSGraphicsContext.saveGraphicsState()
    let glow = NSShadow()
    glow.shadowColor = NSColor.white.withAlphaComponent(0.62)
    glow.shadowBlurRadius = 8
    glow.shadowOffset = .zero
    glow.set()
    coreGradient?.draw(in: core, angle: 0)
    NSGraphicsContext.restoreGraphicsState()
  }

  private func drawSpectrum(in rect: NSRect) {
    let count = 50
    for index in 0..<count {
      let progress = CGFloat(index) / CGFloat(count - 1)
      let hue = (0.54 + progress * 0.42).truncatingRemainder(dividingBy: 1)
      let band = spectrum[index]
      let height = max(3, rect.height * (0.04 + band * 0.9))
      let barWidth = max(1.4, rect.width / CGFloat(count) - 1.1)
      let x = rect.minX + progress * (rect.width - barWidth)
      NSColor(calibratedHue: hue, saturation: 0.82, brightness: 0.98, alpha: 0.95).setFill()
      NSBezierPath(roundedRect: NSRect(x: x, y: rect.midY - height / 2, width: barWidth, height: height),
                   xRadius: barWidth / 2, yRadius: barWidth / 2).fill()
    }
  }

  /// A larger ambient orb with a luminous rim, drifting particles, and
  /// concentric rings that expand and fade with the live microphone level.
  private func drawOrb(in bounds: NSRect) {
    let center = NSPoint(x: bounds.midX, y: bounds.midY - 8)
    let baseRadius: CGFloat = 48 + audioLevel * 8
    for ring in 0..<4 {
      let progress = (CGFloat(ring) / 4 + (phase * 0.035).truncatingRemainder(dividingBy: 1)).truncatingRemainder(dividingBy: 1)
      let radius = baseRadius + progress * 34
      let alpha = max(0.04, 0.34 * (1 - progress) * (0.45 + audioLevel))
      NSColor(calibratedHue: 0.72 - progress * 0.16, saturation: 0.72, brightness: 1, alpha: alpha).setStroke()
      let circle = NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius,
                                                 width: radius * 2, height: radius * 2))
      circle.lineWidth = 1.4
      circle.stroke()
    }
    let glow = NSGradient(colors: [NSColor.systemPurple.withAlphaComponent(0.36),
                                    NSColor.systemBlue.withAlphaComponent(0.08),
                                    .clear])
    glow?.draw(in: NSRect(x: center.x - baseRadius, y: center.y - baseRadius,
                          width: baseRadius * 2, height: baseRadius * 2), relativeCenterPosition: .zero)
    for index in 0..<70 {
      let angle = Double(index) * 2.399 + Double(phase) * (0.015 + Double(index % 4) * 0.002)
      let distance = baseRadius * (0.25 + CGFloat((index * 37) % 71) / 100)
      let x = center.x + CGFloat(cos(angle)) * distance
      let y = center.y + CGFloat(sin(angle)) * distance * 0.72
      let size = 0.7 + CGFloat((index * 13) % 5) * 0.3
      let hue = (0.52 + CGFloat(index % 30) / 90).truncatingRemainder(dividingBy: 1)
      NSColor(calibratedHue: hue, saturation: 0.7, brightness: 1, alpha: 0.35 + audioLevel * 0.55).setFill()
      NSBezierPath(ovalIn: NSRect(x: x - size, y: y - size, width: size * 2, height: size * 2)).fill()
    }
    NSColor.systemBlue.withAlphaComponent(0.8).setFill()
    NSBezierPath(ovalIn: NSRect(x: center.x - 7, y: center.y - 7, width: 14, height: 14)).fill()
    drawText("Listening…", at: NSPoint(x: bounds.midX - 28, y: bounds.maxY - 24), size: 11, color: .white)
  }

  private func drawText(_ text: String, at point: NSPoint, size: CGFloat, color: NSColor) {
    text.draw(at: point, withAttributes: [
      .font: NSFont.systemFont(ofSize: size, weight: .medium),
      .foregroundColor: color,
    ])
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
  private var blueantPanel: BlueantPanel?
  private var wakeIndicator: WakeIndicatorPanel?
  private var wakeWord: WakeWordListener?
  private var wakeEnabled = false
  private var wakeEngineKey = "whisper"
  private var wakeItem: NSMenuItem?
  private var wakeNotificationItem: NSMenuItem?
  private var wakeSpectrumItem: NSMenuItem?
  private var wakeOrbItem: NSMenuItem?
  private let harnessClient = HarnessClient()
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
    wakeIndicator = WakeIndicatorPanel()
    wakeIndicator?.onClose = { [weak self] in self?.blueantPanel?.endWakeConversation() }
    launchBridge()
    installWakeWord()
    beginStatusPolling()
  }

  func applicationWillTerminate(_ notification: Notification) {
    pollTimer?.invalidate()
    nativeConsentPanel?.close()
    nativeConsentPanel = nil
    nativeConsentSeed = nil
    hotkeyCenter?.unregister()
    terminatingBridge = true
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
    NotificationCenter.default.addObserver(self, selector: #selector(panelVisibilityChanged),
                                           name: BlueantPanel.visibilityDidChange, object: panel)
    NotificationCenter.default.addObserver(self, selector: #selector(wakeDictationEnded),
                                           name: BlueantPanel.wakeDictationDidEnd, object: panel)
    NotificationCenter.default.addObserver(self, selector: #selector(wakeAudioLevelChanged),
                                           name: BlueantPanel.wakeAudioLevelDidChange, object: panel)
    NotificationCenter.default.addObserver(self, selector: #selector(wakeVoiceStateChanged),
                                           name: BlueantPanel.wakeVoiceStateDidChange, object: panel)
  }

  /// The wake-word listener only runs while the popup is closed: its trigger
  /// opens the popup, and dictation taps the same input.
  @objc private func panelVisibilityChanged(_ notification: Notification) {
    let visible = notification.userInfo?[BlueantPanel.isVisibleKey] as? Bool ?? false
    if visible {
      wakeWord?.setSuppressed(true)
      return
    }
    // LiveVoiceSession tears down an AVAudioEngine and its voice-processing
    // route when the panel closes. Let CoreAudio finish that transition
    // before opening the wake listener's input tap again.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      guard let self, let panel = self.blueantPanel, !panel.isVisible, self.wakeEnabled else { return }
      self.wakeWord?.setSuppressed(false)
    }
  }

  @objc private func wakeDictationEnded(_ notification: Notification) {
    wakeIndicator?.hide()
    wakeWord?.setSuppressed(false)
  }

  @objc private func wakeAudioLevelChanged(_ notification: Notification) {
    let level = notification.userInfo?["level"] as? Float
    let spectrum = notification.userInfo?["spectrum"] as? [Float]
    DispatchQueue.main.async { [weak self] in
      if let level { self?.wakeIndicator?.setAudioLevel(level) }
      if let spectrum { self?.wakeIndicator?.setSpectrum(spectrum) }
    }
  }

  @objc private func wakeVoiceStateChanged(_ notification: Notification) {
    let status = notification.userInfo?["status"] as? String ?? "Listening…"
    let text = notification.userInfo?["text"] as? String
    DispatchQueue.main.async { [weak self] in
      self?.wakeIndicator?.updateLive(status: status, text: text)
    }
  }

  /// Phase 7b: ambient "hey Blueant". Opt-in via settings; the listener owns
  /// nothing but a rolling buffer and hands off to the popup on trigger.
  private func installWakeWord() {
    NotificationCenter.default.addObserver(self, selector: #selector(wakeWordSettingChanged),
                                           name: BlueantSettingsPane.wakeWordDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(wakeEngineSettingChanged),
                                           name: BlueantSettingsPane.wakeEngineDidChange, object: nil)
    fetchWakeSetting(attempt: 0)
  }

  /// The bridge is still booting at launch, so the first polls retry until it
  /// answers; a permanently dark bridge just leaves the listener off.
  private func fetchWakeSetting(attempt: Int) {
    guard attempt < 30 else {
      NSLog("Blueant wake word: settings unavailable after startup retries")
      return
    }
    harnessClient.fetchSettings { [weak self] result in
      switch result {
      case .success(let settings):
        let enabled = settings["wakeWordEnabled"] as? Bool ?? false
        let engine = settings["wakeEngine"] as? String ?? "whisper"
        DispatchQueue.main.async { self?.applyWake(enabled: enabled, engineKey: engine) }
      case .failure:
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
          self?.fetchWakeSetting(attempt: attempt + 1)
        }
      }
    }
  }

  private func applyWake(enabled: Bool, engineKey _: String? = nil) {
    wakeEnabled = enabled
    if enabled {
      // Keep the always-on detector on Whisper. Parakeet's native decoder is
      // not isolated from the app's other model work and can abort the host
      // process from its ggml worker; it is not suitable for wake-word duty.
      let transcriber: TranscriptionEngine = WhisperEngine.wake
      let resolvedKey = "whisper"
      if wakeWord == nil || wakeEngineKey != resolvedKey {
        wakeWord?.setDesired(false)
        // Parakeet's native ggml decoder is not safe to invoke as a fallback
        // while the app's other audio/model work is active. A decoder crash
        // here terminates the entire menu-bar app, so wake detection uses one
        // serialized engine until Parakeet has an isolated worker owner.
        wakeWord = WakeWordListener(transcriber: transcriber) { [weak self] in self?.wakeFired() }
      }
      blueantPanel?.setWakeTranscriber(transcriber)
      wakeEngineKey = resolvedKey
      wakeWord?.setDesired(true)
    } else {
      wakeWord?.setDesired(false)
    }
    wakeItem?.state = enabled ? .on : .off
  }

  /// Settings-pane toggle or the tray item flipped the stored setting.
  @objc private func wakeWordSettingChanged(_ notification: Notification) {
    let enabled = notification.userInfo?[BlueantSettingsPane.wakeEnabledKey] as? Bool ?? false
    applyWake(enabled: enabled)
  }

  @objc private func wakeEngineSettingChanged(_ notification: Notification) {
    let engine = notification.userInfo?[BlueantSettingsPane.wakeEngineKey] as? String ?? "whisper"
    applyWake(enabled: wakeEnabled, engineKey: engine)
  }

  /// Tray toggle: persist, then apply from the write's echo.
  @objc private func toggleWakeWord() {
    let enabling = wakeItem?.state != .on
    harnessClient.putSettings(["wakeWordEnabled": enabling]) { [weak self] result in
      DispatchQueue.main.async {
        guard let self, case .success = result else { return }
        self.applyWake(enabled: enabling)
        NotificationCenter.default.post(name: BlueantSettingsPane.wakeWordDidChange, object: nil,
                                        userInfo: [BlueantSettingsPane.wakeEnabledKey: enabling])
      }
    }
  }

  /// Wake fired: open the popup (which suppresses the listener) and start
  /// dictation hands-free. The panel's own permission guards apply.
  private func wakeFired() {
    // Whisper finishes on its worker queue. AppKit windows and controls must
    // be touched on the main queue; otherwise a valid wake can be detected
    // while `showPanel()` and the dictation start are silently ignored.
    DispatchQueue.main.async { [weak self] in
      guard let self, let panel = self.blueantPanel else { return }
      let style: WakeIndicatorStyle
      switch UserDefaults.standard.string(forKey: "blueant.wakeIndicator") {
      case "orb": style = .orb
      case "spectrum": style = .spectrum
      default: style = .notification
      }
      self.wakeIndicator?.show(style: style)
      self.wakeWord?.setSuppressed(true)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) {
        panel.beginWakeDictation()
      }
    }
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
    let blueantSettings = NSMenuItem(title: "Blueant Settings…", action: #selector(openBlueantSettings), keyEquivalent: ",")
    blueantSettings.target = self
    menu.addItem(blueantSettings)
    let wake = NSMenuItem(title: "Wake Word", action: #selector(toggleWakeWord), keyEquivalent: "w")
    wake.target = self
    wake.state = .off
    menu.addItem(wake)
    wakeItem = wake
    let indicator = NSMenuItem(title: "Wake Indicator", action: nil, keyEquivalent: "")
    let indicatorMenu = NSMenu()
    let notification = NSMenuItem(title: "Top-right notification", action: #selector(selectWakeNotification), keyEquivalent: "")
    notification.target = self
    let orb = NSMenuItem(title: "Centered orb", action: #selector(selectWakeOrb), keyEquivalent: "")
    orb.target = self
    let spectrum = NSMenuItem(title: "Rainbow spectrum", action: #selector(selectWakeSpectrum), keyEquivalent: "")
    spectrum.target = self
    indicatorMenu.addItem(notification)
    indicatorMenu.addItem(spectrum)
    indicatorMenu.addItem(orb)
    wakeNotificationItem = notification
    wakeSpectrumItem = spectrum
    wakeOrbItem = orb
    indicator.submenu = indicatorMenu
    menu.addItem(indicator)
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
    updateWakeIndicatorMenu()
    updatePresentation()
  }

  @objc private func selectWakeNotification() {
    UserDefaults.standard.set("notification", forKey: "blueant.wakeIndicator")
    updateWakeIndicatorMenu()
  }

  @objc private func selectWakeSpectrum() {
    UserDefaults.standard.set("spectrum", forKey: "blueant.wakeIndicator")
    updateWakeIndicatorMenu()
  }

  @objc private func selectWakeOrb() {
    UserDefaults.standard.set("orb", forKey: "blueant.wakeIndicator")
    updateWakeIndicatorMenu()
  }

  private func updateWakeIndicatorMenu() {
    let selected = UserDefaults.standard.string(forKey: "blueant.wakeIndicator") ?? "notification"
    wakeNotificationItem?.state = selected == "notification" ? .on : .off
    wakeSpectrumItem?.state = selected == "spectrum" ? .on : .off
    wakeOrbItem?.state = selected == "orb" ? .on : .off
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
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
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

  @objc private func toggleBlueant() {
    guard let panel = blueantPanel else { return }
    if !panel.isVisible {
      // Fresh opens anchor under the status item.
      panel.positionUnder(anchorRect: nil)
    }
    panel.toggle()
  }

  @objc private func openBlueantSettings() {
    guard let panel = blueantPanel else { return }
    if !panel.isVisible {
      panel.positionUnder(anchorRect: nil)
    }
    panel.showSettings()
  }

  @objc private func startHarness() {
    userStopped = false
    requestHarness("start", successState: .running, openAfterSuccess: true)
  }

  @objc private func stopHarness() {
    userStopped = true
    requestHarness("stop", successState: .stopped)
  }

  /// Restart the Harness through the bridge, matching `dsh anton restart`.
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

  /// Act-tier delivery: pull notifications the bridge inbox queued for us
  /// (blueant_notify and any loopback caller), present each through
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
}

/// Presents Blueant notifications even when the app is frontmost; without
/// this delegate macOS silently drops banners for accessory apps in the
/// foreground.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(_ center: UNUserNotificationCenter,
                              willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }
}

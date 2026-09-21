import Cocoa

/// The Blueant popup: a borderless, non-activating HUD panel anchored under
/// the menubar. One line of entry, a streamed answer area, a footer keybar.
/// Esc hides (cancelling any in-flight turn); focus loss hides; the frame
/// persists across launches in UserDefaults.
final class BlueantPanel: NSPanel, NSWindowDelegate {
  private let client = HarnessClient()
  // Editable field, not a label: labelWithString: fields are non-editable
  // and cannot become first responder, so keystrokes would go nowhere.
  // The subclass permits window movement so the panel drags by its entry
  // line, Spotlight-style (AppKit still delivers click-to-edit).
  private let entryField = DragTextField(string: "")
  private let promptMark = NSTextField(labelWithString: ">")
  private let answerView = NSTextView()
  private let footerLabel = NSTextField(labelWithString: "")
  private let scroll = NSScrollView()
  private let divider = NSBox()
  private var mux: HarnessClient.MuxStream?
  private var answer = ""
  private var streamingSessionId: String?
  private var lastQuestion = ""
  private var lastProvenance: String?
  private var waking = false
  private var hasPositioned = false
  // Spotlight behavior: compact (entry + keybar only) until answer content
  // exists, then expands; the dragged position persists, the height adapts.
  private var isCompact = true
  private static let compactHeight: CGFloat = 100
  private static let expandedHeight: CGFloat = 420
  // Voice mode (Phase 3): push-to-talk via the waveform tile and panel-local ⌥Space.
  private let micButton = MicButton()
  // Settings (gear at the entry line's right): journal toggle + model pick.
  private let settingsButton = NSButton()
  private var settingsPopover: NSPopover?
  private let speech = SpeechController()
  private var voiceKeyMonitor: Any?
  private var micDownAt: Date?
  private var entrySnapshot = ""
  private var speechDisabledForSession = false
  private static let micHoldToggleThreshold: TimeInterval = 0.25

  private static let frameKey = "blueant.panel.frame"
  private static let sessionPrefix = "blueant.session."
  private static let workspacePath: String = {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Anton", isDirectory: true)
      .appendingPathComponent("blueant", isDirectory: true).path
  }()

  init() {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: BlueantPanel.compactHeight),
               styleMask: [.borderless, .nonactivatingPanel],
               backing: .buffered, defer: false)
    level = .floating
    isReleasedWhenClosed = false
    hidesOnDeactivate = true
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    isOpaque = false
    backgroundColor = .clear
    appearance = NSAppearance(named: .darkAqua)
    animationBehavior = .utilityWindow
    isMovableByWindowBackground = true // drag anywhere on the chrome, Spotlight-style
    delegate = self
    buildContent()
    if let saved = UserDefaults.standard.string(forKey: Self.frameKey) {
      let rect = NSRectFromString(saved)
      if rect.width > 100 {
        // Restore the dragged position and width, but always open compact —
        // the height adapts to content again.
        var frame = rect
        frame.size.height = Self.compactHeight
        setFrame(frame, display: false)
        hasPositioned = true
      }
    }
  }

  required init?(coder: NSCoder) { nil }

  private func buildContent() {
    let hud = DragHUDView(frame: NSRect(x: 0, y: 0, width: 640, height: BlueantPanel.compactHeight))
    hud.material = .hudWindow
    hud.blendingMode = .behindWindow
    hud.state = .active
    hud.wantsLayer = true
    hud.layer?.cornerRadius = 12
    contentView = hud

    let promptMark = self.promptMark
    promptMark.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .medium)
    promptMark.textColor = .secondaryLabelColor
    hud.addSubview(promptMark)

    entryField.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .regular)
    entryField.placeholderString = "Ask Blueant…"
    entryField.isBezeled = false
    entryField.isBordered = false
    entryField.drawsBackground = false
    entryField.focusRingType = .none
    entryField.target = self
    entryField.action = #selector(submit)
    hud.addSubview(entryField)

    divider.boxType = .separator
    hud.addSubview(divider)

    answerView.isEditable = false
    answerView.drawsBackground = false
    answerView.textContainerInset = NSSize(width: 4, height: 8)
    answerView.font = NSFont.systemFont(ofSize: 13)
    scroll.hasVerticalScroller = true
    scroll.borderType = .noBorder
    scroll.drawsBackground = false
    scroll.documentView = answerView
    hud.addSubview(scroll)

    footerLabel.font = NSFont.systemFont(ofSize: 11)
    footerLabel.textColor = .tertiaryLabelColor
    footerLabel.stringValue = "⏎ ask · ⌘N new thread · ⌘C copy · ⌘P promote · ⌘E open in Anton · hold ⌥Space talk · Esc close"
    hud.addSubview(footerLabel)

    micButton.target = self
    micButton.action = nil // handled by mouseDown/mouseUp (hold-to-talk)
    micButton.onDown = { [weak self] in
      guard let self else { return }
      if self.speech.isListening && self.micDownAt == nil {
        self.micClickedWhileListening() // quick click while hands-free: stop
      } else {
        self.micDown()
      }
    }
    micButton.onUp = { [weak self] in self?.micUp() }
    hud.addSubview(micButton)

    settingsButton.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: "Settings")
    settingsButton.isBordered = false
    settingsButton.bezelStyle = .accessoryBar
    settingsButton.contentTintColor = .tertiaryLabelColor
    settingsButton.toolTip = "Settings (⌘,)"
    settingsButton.target = self
    settingsButton.action = #selector(openSettings(_:))
    hud.addSubview(settingsButton)

    layoutContent(in: NSRect(x: 0, y: 0, width: 640, height: BlueantPanel.compactHeight))
    hud.postsFrameChangedNotifications = true
    NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: hud, queue: .main) { [weak self] _ in
      guard let self, let hud = self.contentView else { return }
      self.layoutContent(in: hud.bounds)
    }
  }

  private func layoutContent(in bounds: NSRect) {
    let width = bounds.width
    let height = bounds.height
    let micWidth: CGFloat = 30
    micButton.frame = NSRect(x: width - micWidth - 12, y: height - 46, width: micWidth, height: 26)
    settingsButton.frame = NSRect(x: width - micWidth - 38, y: height - 44, width: 24, height: 22)
    entryField.frame = NSRect(x: 40, y: height - 44, width: width - 56 - micWidth - 4, height: 24)
    promptMark.frame = NSRect(x: 16, y: height - 44, width: 16, height: 22)
    divider.frame = NSRect(x: 16, y: height - 52, width: width - 32, height: 4)
    scroll.frame = NSRect(x: 12, y: 30, width: width - 24, height: height - 90)
    scroll.isHidden = isCompact
    footerLabel.frame = NSRect(x: 16, y: 8, width: width - 32, height: 16)
  }

  /// Grow or shrink between the Spotlight-compact card and the full answer
  /// window, keeping the top edge (the entry line) anchored in place.
  private func applySize(compact: Bool, animate: Bool) {
    guard isCompact != compact else { return }
    isCompact = compact
    var frame = self.frame
    let oldHeight = frame.height
    frame.size.height = compact ? Self.compactHeight : Self.expandedHeight
    frame.origin.y += oldHeight - frame.size.height
    setFrame(frame, display: true, animate: animate)
    UserDefaults.standard.set(NSStringFromRect(self.frame), forKey: Self.frameKey)
  }

  // MARK: Show / hide

  func toggle() {
    if isVisible { closePanel() } else { showPanel() }
  }

  func showPanel() {
    if !hasPositioned { positionUnder(anchorRect: nil) }
    applySize(compact: answer.isEmpty, animate: false)
    NSApp.activate(ignoringOtherApps: true)
    makeKeyAndOrderFront(nil)
    makeFirstResponder(entryField)
    installVoiceKeyMonitor()
  }

  func closePanel() {
    stopVoice(forHide: true)
    removeVoiceKeyMonitor()
    cancelStreaming()
    UserDefaults.standard.set(NSStringFromRect(frame), forKey: Self.frameKey)
    orderOut(nil)
  }

  /// Default placement: horizontally centered, roughly a third down from the
  /// top of the screen — where Spotlight and Alfred appear. Clamped to the
  /// main screen's visible frame.
  func positionUnder(anchorRect: NSRect?) {
    guard let screen = NSScreen.main else { return }
    let visible = screen.visibleFrame
    var origin: NSPoint
    if let anchorRect {
      origin = NSPoint(x: anchorRect.midX - frame.width / 2, y: anchorRect.minY - frame.height - 8)
    } else {
      origin = NSPoint(x: visible.midX - frame.width / 2,
                       y: visible.maxY - visible.height * 0.30 - frame.height)
    }
    origin.x = min(max(visible.minX + 8, origin.x), visible.maxX - frame.width - 8)
    origin.y = min(max(visible.minY + 8, origin.y), visible.maxY - frame.height - 8)
    setFrameOrigin(origin)
    hasPositioned = true
  }

  override var canBecomeKey: Bool { true }

  func windowDidResignKey(_ notification: Notification) {
    // Focus loss hides. (App-level deactivation is covered by hidesOnDeactivate.)
    if isVisible { closePanel() }
  }

  /// Key equivalents are consulted before the field editor consumes keys.
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard mods == [.command] else { return super.performKeyEquivalent(with: event) }
    switch event.charactersIgnoringModifiers {
    case "n":
      newThread(nil)
      return true
    case "c":
      copyAnswer(nil)
      return true
    case "e":
      openInAnton(nil)
      return true
    case "p":
      promote(nil)
      return true
    case ",":
      openSettings(nil)
      return true
    default:
      return super.performKeyEquivalent(with: event)
    }
  }

  override func cancelOperation(_ sender: Any?) {
    closePanel()
  }

  // MARK: Voice mode (push-to-talk)


/// The waveform tile doubles as hold-to-talk and toggle:
  /// - mouseDown starts; mouseUp stops if held ≥250 ms (hold-to-talk);
  /// - a click shorter than 250 ms toggles hands-free mode (click to start,
  ///   click again to stop).
  /// ⌥Space works the same way via a panel-local key monitor (only while the
  /// panel is key). Plain ⌥Space was chosen over the global Carbon ⇧⌥Space
  /// hotkey because key-up tracking would otherwise need a global event tap
  /// and Accessibility permission.
  private func micDown() {
    guard !speechDisabledForSession, !speech.isListening else { return }
    micDownAt = Date()
    entrySnapshot = entryField.stringValue
    startListening()
  }

  private func micUp() {
    guard let downAt = micDownAt else { return }
    micDownAt = nil
    let held = Date().timeIntervalSince(downAt)
    if held >= Self.micHoldToggleThreshold {
      stopListening()
    }
    // Held < threshold: treated as a click — keep listening (toggle state).
  }

  private func micClickedWhileListening() {
    stopListening()
  }

  private func startListening() {
    SpeechController.requestPermissions { [weak self] granted, denial in
      guard let self else { return }
      guard granted else {
        self.speechDisabledForSession = true
        self.micButton.isEnabled = false
        self.renderAnswer(status: "Microphone/Speech permission denied (\(denial ?? "permission")) — type instead")
        return
      }
      self.speech.start(callbacks: SpeechController.Callbacks(
        onPartial: { [weak self] partial in self?.renderPartial(partial) },
        onLevel: { [weak self] level in self?.micButton.setLevel(level) },
        onFinish: { [weak self] final in self?.landFinalTranscript(final) },
        onFailure: { [weak self] message in
          guard let self else { return }
          self.speechDisabledForSession = true
          self.micButton.isEnabled = false
          self.micButton.setListening(false)
          self.renderAnswer(status: message)
        }
      ))
      self.micButton.setListening(true)
      self.renderPartial("")
    }
  }

  private func stopListening() {
    micButton.setListening(false)
    speech.stop()
  }

  /// Interim transcript: a bare red dot marks recording (the waveform tile
  /// already carries state); the partial itself renders grey with a trailing
  /// ellipsis over the snapshot of whatever the user had typed before
  /// speaking. Never submitted.
  private func renderPartial(_ partial: String) {
    let text = NSMutableAttributedString(string: "● ")
    text.addAttributes([.foregroundColor: NSColor.systemRed], range: NSRange(location: 0, length: text.length))
    if !partial.isEmpty {
      text.append(NSAttributedString(string: partial + "…", attributes: [
        .foregroundColor: NSColor.secondaryLabelColor,
      ]))
    }
    entryField.attributedStringValue = text
  }

  /// Final transcript replaces the partial in the entry field and focus moves
  /// back to the field for review; the user submits with ⏎ themselves.
  private func landFinalTranscript(_ final: String) {
    micButton.setListening(false)
    let trimmed = final.trimmingCharacters(in: .whitespacesAndNewlines)
    var combined = entrySnapshot
    if !trimmed.isEmpty {
      combined = combined.isEmpty ? trimmed : combined + " " + trimmed
    }
    entryField.stringValue = combined
    makeFirstResponder(entryField)
    if let editor = entryField.currentEditor() {
      editor.moveToEndOfDocument(nil)
    }
  }

  private func installVoiceKeyMonitor() {
    guard voiceKeyMonitor == nil else { return }
    voiceKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
      guard let self, self.isKeyPanel else { return event }
      let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      guard event.keyCode == 49, mods == [.option] else { return event }
      if self.speechDisabledForSession { return nil }
      switch event.type {
      case .keyDown:
        if !self.speech.isListening { self.micDown() }
      case .keyUp:
        if self.micDownAt != nil { self.micUp() }
      default:
        break
      }
      return nil // swallow: ⌥Space belongs to push-to-talk while the panel is key
    }
  }

  private func removeVoiceKeyMonitor() {
    if let monitor = voiceKeyMonitor {
      NSEvent.removeMonitor(monitor)
      voiceKeyMonitor = nil
    }
  }

  private var isKeyPanel: Bool { isKeyWindow }

  /// Panel hid or resigned key: abort recognition with no final transcript
  /// and restore the pre-dictation entry text (partials are discarded).
  private func stopVoice(forHide: Bool) {
    guard speech.isListening || micDownAt != nil else { return }
    micDownAt = nil
    micButton.setListening(false)
    speech.abort()
    entryField.stringValue = entrySnapshot
  }

  // MARK: Asking

  @objc private func submit() {
    ask(entryField.stringValue)
  }

  func ask(_ rawText: String) {
    let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !waking else { return }
    entryField.stringValue = ""
    answer = ""
    lastQuestion = text
    let contextSnapshot = DesktopContext.snapshot(prompt: text)
    lastProvenance = contextSnapshot.provenance
    renderAnswer(status: "…")

    let todayKey = Self.sessionPrefix + Self.todayStamp()
    let proceed: (String) -> Void = { [weak self] sessionId in
      self?.sendPrompt(sessionId: sessionId, text: contextSnapshot.context + text)
    }
    client.harnessRunning { [weak self] running in
      DispatchQueue.main.async {
        guard let self else { return }
        if running {
          self.resolveSession(key: todayKey, then: proceed)
          return
        }
        // Harness down: wake it first, then continue.
        self.waking = true
        self.renderAnswer(status: "Waking Anton…")
        self.client.startHarness { [weak self] _ in
          DispatchQueue.main.async {
            guard let self else { return }
            self.waking = false
            self.resolveSession(key: todayKey, then: proceed)
          }
        }
      }
    }
  }

  /// Returns the stored id for today when present; otherwise creates a fresh
  /// session through the API and stores it under the day key.
  private func resolveSession(key: String, then proceed: @escaping (String) -> Void) {
    if let stored = UserDefaults.standard.string(forKey: key), !stored.isEmpty {
      proceed(stored)
      return
    }
    try? FileManager.default.createDirectory(atPath: Self.workspacePath, withIntermediateDirectories: true)
    client.createSession(cwd: Self.workspacePath, preset: "blueant") { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        switch result {
        case .success(let sessionId):
          UserDefaults.standard.set(sessionId, forKey: key)
          self.applyStoredModel(to: sessionId) { applied in
            _ = applied // a failed preference application never blocks the ask
            proceed(sessionId)
          }
        case .failure(let error):
          self.renderAnswer(status: "Blueant could not open a session: \(error.localizedDescription)")
        }
      }
    }
  }

  private func sendPrompt(sessionId: String, text: String) {
    guard !sessionId.isEmpty else { return }
    streamingSessionId = sessionId
    let stream = HarnessClient.MuxStream()
    stream.onDelta = { [weak self] delta in
      self?.answer += delta
      self?.renderAnswer(status: "")
    }
    stream.onTurnEnd = { [weak self] in
      self?.finishStreaming()
    }
    stream.onError = { [weak self] message in
      self?.finishStreaming()
      self?.renderAnswer(status: " ⚠︎ \(message)")
    }
    mux = stream
    stream.connect(sessionId: sessionId)
    client.prompt(sessionId: sessionId, text: text) { [weak self] result in
      DispatchQueue.main.async {
        if case .failure(let error) = result {
          self?.finishStreaming()
          self?.renderAnswer(status: " ⚠︎ \(error.localizedDescription)")
        }
      }
    }
  }

  /// Esc or re-ask while streaming: abandon the in-flight turn but keep the
  /// rolling thread.
  private func cancelStreaming() {
    guard let sessionId = streamingSessionId else { return }
    client.cancel(sessionId: sessionId)
    finishStreaming()
  }

  private func finishStreaming() {
    mux?.close()
    mux = nil
    streamingSessionId = nil
  }

  /// ⌘N: abandon today's thread; the next ask opens a fresh session.
  @objc func newThread(_ sender: Any?) {
    cancelStreaming()
    UserDefaults.standard.removeObject(forKey: Self.sessionPrefix + Self.todayStamp())
    answer = ""
    renderAnswer(status: "New thread ready.")
    makeFirstResponder(entryField)
  }

  @objc func copyAnswer(_ sender: Any?) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(answer, forType: .string)
  }

  // MARK: Session promotion

  /// ⌘E: open the web GUI. The GUI has no per-session URL (its only deep
  /// link is the `#ws=<workspaceId>` board pin), so this lands on the session
  /// list where the Blueant thread is the most recent entry.
  @objc func openInAnton(_ sender: Any?) {
    guard let url = URL(string: "http://127.0.0.1:3742/") else { return }
    NSWorkspace.shared.open(url)
  }

  /// ⌘P: fork today's Blueant thread into a standalone coding session titled
  /// after the last question, then open the GUI so the copy is topmost in the
  /// session list. Cancels any in-flight stream first; the fork carries the
  /// full transcript, so the answer seeds the coding session without
  /// copy-paste.
  /// ⌘, / gear: the settings popover — journal switch + model picker.
  @objc private func openSettings(_ sender: Any?) {
    let pane = BlueantSettingsPane(client: client, resolve: { [weak self] done in
      self?.resolveSession(key: Self.sessionPrefix + Self.todayStamp()) { sessionId in
        done(sessionId.isEmpty ? nil : sessionId)
      }
    })
    let popover = NSPopover()
    popover.contentViewController = pane
    popover.behavior = .transient
    popover.contentSize = pane.view.fittingSize
    settingsPopover = popover
    popover.show(relativeTo: settingsButton.bounds, of: settingsButton, preferredEdge: .minY)
  }

  /// Apply the stored model preference to a session (no-op when unset).
  private func applyStoredModel(to sessionId: String, then completion: @escaping (Bool) -> Void) {
    client.fetchSettings { result in
      DispatchQueue.main.async {
        guard case .success(let settings) = result,
              let model = settings["model"] as? [String: Any],
              let provider = model["provider"] as? String,
              let name = model["model"] as? String else {
          completion(false)
          return
        }
        self.client.selectModel(sessionId: sessionId, provider: provider, model: name) { selected in
          DispatchQueue.main.async { completion(selected.isSuccess) }
        }
      }
    }
  }

  @objc func promote(_ sender: Any?) {
    let todayKey = Self.sessionPrefix + Self.todayStamp()
    guard let sessionId = UserDefaults.standard.string(forKey: todayKey), !sessionId.isEmpty,
          !answer.isEmpty else {
      renderAnswer(status: "Nothing to promote yet — ask first.")
      return
    }
    cancelStreaming()
    let seedTitle = "Blueant: " + String(lastQuestion.prefix(60))
    client.fork(sessionId: sessionId) { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        switch result {
        case .success(let childId):
          self.client.rename(sessionId: childId, title: seedTitle) { _ in
            DispatchQueue.main.async { self.openInAnton(nil) }
          }
        case .failure(let error):
          self.renderAnswer(status: " ⚠︎ promote failed: \(error.localizedDescription)")
        }
      }
    }
  }

  // MARK: Rendering

  /// Plain-attributed MVP rendering: status line first, streamed text below.
  /// Real content — an answer or a message the user must read — expands the
  /// panel downward; transient progress markers ("…", "Waking Anton…") keep
  /// it slim, like Spotlight growing only when results appear.
  private func renderAnswer(status: String) {
    let transient = status.isEmpty || status == "…" || status == "Waking Anton…"
    applySize(compact: answer.isEmpty && transient, animate: true)
    let text = NSMutableAttributedString()
    // Provenance header, Arivu-style: what this answer's context read. Only
    // shows once there is an answer to attribute.
    if !answer.isEmpty, let provenance = lastProvenance {
      text.append(NSAttributedString(string: "Read: " + provenance + "\n\n", attributes: [
        .font: NSFont.systemFont(ofSize: 11),
        .foregroundColor: NSColor.tertiaryLabelColor,
      ]))
    }
    if !status.isEmpty {
      text.append(NSAttributedString(string: status + "\n\n", attributes: [
        .font: NSFont.systemFont(ofSize: 12),
        .foregroundColor: NSColor.secondaryLabelColor,
      ]))
    }
    text.append(NSAttributedString(string: answer, attributes: [
      .font: NSFont.systemFont(ofSize: 13),
      .foregroundColor: NSColor.labelColor,
    ]))
    answerView.textStorage?.setAttributedString(text)
    answerView.scrollToEndOfDocument(nil)
  }

  private static func todayStamp() -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: Date())
  }
}


// Convenience for the fire-and-forget paths above.
private extension Result {
var isSuccess: Bool {
  if case .success = self { return true }
  return false
}
}

/// The settings popover content: a journal enable/disable switch (the same
/// switch idiom as the web GUI's toggles) and a model picker fed by the
/// harness's live session.models catalog. Writes go to the bridge settings
/// store; a model pick also selects on the live session for immediate
/// effect, and the stored preference rides every new day's session.
final class BlueantSettingsPane: NSViewController {
private let client: HarnessClient
/// Resolves today's session id, creating the session when none exists —
/// session.models needs a live session to enumerate its catalog.
private let resolve: (@escaping (String?) -> Void) -> Void
private let journalSwitch = NSSwitch()
private let modelMenu = NSPopUpButton()
private let statusLine = NSTextField(labelWithString: "")

init(client: HarnessClient, resolve: @escaping (@escaping (String?) -> Void) -> Void) {
  self.client = client
  self.resolve = resolve
  super.init(nibName: nil, bundle: nil)
}

@available(*, unavailable)
required init?(coder: NSCoder) { fatalError("programmatic view") }

override func loadView() {
  let container = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 132))
  container.translatesAutoresizingMaskIntoConstraints = false

  let journalLabel = NSTextField(labelWithString: "Journal (ambient capture)")
  journalLabel.font = .systemFont(ofSize: 12, weight: .medium)
  journalSwitch.controlSize = .small
  journalSwitch.target = self
  journalSwitch.action = #selector(journalToggled(_:))

  let modelLabel = NSTextField(labelWithString: "Model")
  modelLabel.font = .systemFont(ofSize: 12, weight: .medium)
  modelMenu.controlSize = .small
  modelMenu.addItem(withTitle: "Loading…")
  modelMenu.target = self
  modelMenu.action = #selector(modelPicked(_:))

  statusLine.font = .systemFont(ofSize: 10)
  statusLine.textColor = .tertiaryLabelColor
  statusLine.stringValue = "Journal writes desktop context to the daily log."

  for sub in [journalLabel, journalSwitch, modelLabel, modelMenu, statusLine] {
    sub.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(sub)
  }
  NSLayoutConstraint.activate([
    journalLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
    journalLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
    journalSwitch.centerYAnchor.constraint(equalTo: journalLabel.centerYAnchor),
    journalSwitch.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
    modelLabel.topAnchor.constraint(equalTo: journalLabel.bottomAnchor, constant: 18),
    modelLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
    modelMenu.centerYAnchor.constraint(equalTo: modelLabel.centerYAnchor),
    modelMenu.leadingAnchor.constraint(equalTo: journalSwitch.leadingAnchor),
    modelMenu.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
    statusLine.topAnchor.constraint(equalTo: modelLabel.bottomAnchor, constant: 14),
    statusLine.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
  ])
  view = container
  reload()
}

private func reload() {
  client.fetchSettings { [weak self] result in
    DispatchQueue.main.async {
      guard let self, self.isViewLoaded else { return }
      guard case .success(let settings) = result else {
        self.statusLine.stringValue = "Settings unavailable — bridge not answering."
        return
      }
      self.journalSwitch.state = (settings["journalEnabled"] as? Bool ?? true) ? .on : .off
      self.loadModels(stored: settings["model"] as? [String: Any])
    }
  }
}

private func loadModels(stored: [String: Any]?) {
  resolve { [weak self] sessionId in
    guard let self else { return }
    self.resolvedSessionHolder = sessionId
    guard let sessionId, !sessionId.isEmpty else {
      DispatchQueue.main.async {
        self.modelMenu.removeAllItems()
        self.modelMenu.addItem(withTitle: "Default (no session yet)")
      }
      return
    }
    self.client.listModels(sessionId: sessionId) { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.isViewLoaded else { return }
        self.modelMenu.removeAllItems()
        self.modelMenu.addItem(withTitle: "Default")
        guard case .success(let groups) = result else {
          self.modelMenu.addItem(withTitle: "Models unavailable")
          return
        }
        var selected: Int = 0
        let storedProvider = stored?["provider"] as? String
        let storedModel = stored?["model"] as? String
        for group in groups {
          let provider = group["id"] as? String ?? "unknown"
          let providerName = group["name"] as? String ?? provider
          self.providerIds[providerName] = provider
          let models = group["models"] as? [[String: Any]] ?? []
          for entry in models {
            let id = entry["id"] as? String ?? ""
            guard !id.isEmpty else { continue }
            self.modelMenu.addItem(withTitle: "\(providerName) — \(id)")
            if provider == storedProvider && id == storedModel {
              selected = self.modelMenu.numberOfItems - 1
            }
          }
        }
        self.modelMenu.selectItem(at: selected)
      }
    }
  }
}

@objc private func journalToggled(_ sender: NSSwitch) {
  let enabled = sender.state == .on
  statusLine.stringValue = enabled ? "Journal writes desktop context to the daily log."
                                   : "Journal paused — no new capture or triage."
  client.putSettings(["journalEnabled": enabled]) { [weak self] _ in
    DispatchQueue.main.async { self?.reload() }
  }
}

@objc private func modelPicked(_ sender: NSPopUpButton) {
  // Resolve the title back to provider/model ids stored per-item earlier.
  guard let item = sender.selectedItem else { return }
  let title = item.title
  if title == "Default" {
    client.putSettings(["model": NSNull()]) { _ in }
    return
  }
  guard let sessionIdProvider = resolvedSessionId else { return }
  let parts = title.components(separatedBy: " — ")
  guard parts.count == 2 else { return }
  let (providerName, modelId) = (parts[0], parts[1])
  let providerId = providerIds[providerName] ?? providerName
  client.putSettings(["model": ["provider": providerId, "model": modelId]]) { _ in }
  client.selectModel(sessionId: sessionIdProvider, provider: providerId, model: modelId) { _ in }
}

private var resolvedSessionId: String? { resolvedSessionHolder }
private var resolvedSessionHolder: String?
private var providerIds: [String: String] = [:]
}

/// The push-to-talk tile: the SF Symbol "waveform" rendered white on a
/// rounded-rect tint, echoing Apple's waveform glyph. `action` is unused;
/// mouseDown/mouseUp are reported to the owning panel via closures so
/// hold-vs-click timing lives in BlueantPanel. While listening the tile
/// tints red and the level meter pulses tint and brightness (NSButton has
/// no symbol-effect API, so the pulse is driven from the audio level).
final class MicButton: NSButton {
  var onDown: (() -> Void)?
  var onUp: (() -> Void)?
  private static let idleTile = NSColor.white.withAlphaComponent(0.14)
  private static let liveTile = NSColor.systemRed.withAlphaComponent(0.45)

  init() {
    super.init(frame: NSRect(x: 0, y: 0, width: 30, height: 26))
    image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Talk")
    symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
    isBordered = false
    imageScaling = .scaleProportionallyDown
    contentTintColor = .white
    wantsLayer = true
    layer?.cornerRadius = 6
    layer?.masksToBounds = true
    layer?.backgroundColor = Self.idleTile.cgColor
    setAccessibilityLabel("Talk")
  }

  required init?(coder: NSCoder) { nil }

  override func mouseDown(with event: NSEvent) {
    onDown?()
  }

  override func mouseUp(with event: NSEvent) {
    onUp?()
  }

  func setListening(_ listening: Bool) {
    layer?.backgroundColor = (listening ? Self.liveTile : Self.idleTile).cgColor
    if !listening { alphaValue = isEnabled ? 1.0 : 0.4 }
  }

  /// Average input power in dB (−60…0); pulses the tile tint and glyph while
  /// listening. NSButton carries no symbol-effect API, so the level meter
  /// drives the animation.
  func setLevel(_ level: Float) {
    guard isEnabled else { return }
    let normalized = CGFloat(max(0, min(1, (level + 60) / 60)))
    alphaValue = 0.55 + 0.45 * normalized
    contentTintColor = NSColor.white.blended(withFraction: 0.3 * normalized, of: .systemPink)
  }

  override var isEnabled: Bool {
    get { super.isEnabled }
    set {
      super.isEnabled = newValue
      alphaValue = newValue ? 1.0 : 0.4
    }
  }
}

/// HUD background that hands drags to the window: without this,
/// `isMovableByWindowBackground` has nothing to grab — NSVisualEffectView
/// reports `mouseDownCanMoveWindow == false` by default.
final class DragHUDView: NSVisualEffectView {
  override var mouseDownCanMoveWindow: Bool { true }
}

/// Entry field that still takes click-to-edit but also starts a window drag
/// when the user moves the mouse — Spotlight drags exactly this way, by its
/// search field.
final class DragTextField: NSTextField {
  override var mouseDownCanMoveWindow: Bool { true }
}

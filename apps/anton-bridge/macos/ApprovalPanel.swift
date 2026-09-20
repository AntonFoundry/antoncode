import Cocoa

/// Propose-then-approve surface (Act tier): a small floating panel that
/// shows the exact shell command Blueant wants to run, with Approve & Run
/// and Deny buttons. One instance, re-presented per proposal; closing the
/// panel or pressing Esc counts as Deny — an ignored proposal must never
/// linger as a zombie waiting on a decision nobody will give.
final class ApprovalPanel: NSPanel {
  private var proposalId: String?
  private var onDecide: ((Bool) -> Void)?
  private let commandLabel = NSTextField(wrappingLabelWithString: "")
  private let hintLabel = NSTextField(labelWithString: "")

  init() {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 190),
               styleMask: [.titled, .nonactivatingPanel, .utilityWindow],
               backing: .buffered, defer: false)
    title = "Blueant — action approval"
    isOpaque = false
    backgroundColor = .clear
    level = .floating
    isMovableByWindowBackground = true
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

    let hud = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 560, height: 190))
    hud.material = .hudWindow
    hud.blendingMode = .behindWindow
    hud.state = .active
    hud.wantsLayer = true
    hud.layer?.cornerRadius = 12
    contentView = hud

    let titleField = NSTextField(labelWithString: "Blueant wants to run:")
    titleField.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    titleField.textColor = .labelColor
    titleField.frame = NSRect(x: 16, y: 148, width: 528, height: 20)
    hud.addSubview(titleField)

    commandLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    commandLabel.textColor = .labelColor
    commandLabel.isSelectable = true
    commandLabel.frame = NSRect(x: 16, y: 62, width: 528, height: 78)
    commandLabel.autoresizingMask = [.width]
    hud.addSubview(commandLabel)

    hintLabel.font = NSFont.systemFont(ofSize: 11)
    hintLabel.textColor = .secondaryLabelColor
    hintLabel.stringValue = "Runs in the Blueant workspace · 30s limit · output goes back to Blueant"
    hintLabel.frame = NSRect(x: 16, y: 40, width: 528, height: 16)
    hud.addSubview(hintLabel)

    let deny = NSButton(title: "Deny", target: self, action: #selector(denyClicked))
    deny.bezelStyle = .rounded
    deny.controlSize = .large
    deny.frame = NSRect(x: 430, y: 8, width: 114, height: 30)
    hud.addSubview(deny)

    let approve = NSButton(title: "Approve & Run", target: self, action: #selector(approveClicked))
    approve.bezelStyle = .rounded
    approve.controlSize = .large
    approve.keyEquivalent = "\r"
    approve.frame = NSRect(x: 308, y: 8, width: 114, height: 30)
    hud.addSubview(approve)

    // Esc = Deny: the panel must never trap the user without an exit that
    // resolves the proposal.
    let escape = NSButton(title: "", target: self, action: #selector(denyClicked))
    escape.keyEquivalent = "\u{1b}"
    escape.sizeToFit()
    escape.frame = NSRect(x: -100, y: -100, width: 0, height: 0)
    hud.addSubview(escape)

    center()
  }

  func present(id: String, command: String, decide: @escaping (Bool) -> Void) {
    proposalId = id
    onDecide = decide
    commandLabel.stringValue = command
    orderFront(nil)
    // makeKeyAndOrderFront without activating the app: the buttons need key
    // equivalents (Ret/Esc) to work, but Anton stays an accessory app.
    makeKeyAndOrderFront(nil)
  }

  @objc private func approveClicked() { finish(approved: true) }
  @objc private func denyClicked() { finish(approved: false) }

  private func finish(approved: Bool) {
    orderOut(nil)
    guard proposalId != nil else { return }
    proposalId = nil
    onDecide?(approved)
    onDecide = nil
  }

  override func cancelOperation(_ sender: Any?) { finish(approved: false) }
  override func resignKey() {
    // Losing focus (user clicked elsewhere) is not a decision; the panel
    // stays until Approve, Deny, or Esc.
  }
}

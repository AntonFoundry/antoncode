import Carbon.HIToolbox
import Cocoa

/// Blueant's global hotkey constants. Change these two values to rebind the
/// popup: `keyCode` is a Carbon virtual key code (49 = Space), `modifiers`
/// is a Carbon modifier mask — NOT CGEventFlags, which number its modifiers
/// differently (CG shift/option are 1<<17/1<<19; Carbon's constants are below).
enum BlueantHotkey {
  static let keyCode: UInt32 = UInt32(kVK_Space)
  static let modifiers: UInt32 = UInt32(shiftKey) | UInt32(optionKey) // ⇧⌥
}

/// Registers one system-wide Carbon hotkey that toggles the Blueant panel.
/// Registration is idempotent; a failure is logged and the app keeps working
/// through the menubar item.
final class HotkeyCenter {
  private var hotKeyRef: EventHotKeyRef?
  private var installed = false
  private var toggle: (() -> Void)?

  /// Installs ⇧⌥Space. Returns false when Carbon refuses the registration.
  @discardableResult
  func register(toggleAction: @escaping () -> Void) -> Bool {
    guard !installed else { return true }
    toggle = toggleAction
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    var handlerRef: EventHandlerRef?
    let selfPtr = Unmanaged.passRetained(self).toOpaque()
    let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
      // The only registered hotkey is Blueant's, so the direct-object check is
      // unnecessary: every hotkey-pressed event here is ours.
      let center = Unmanaged<HotkeyCenter>.fromOpaque(userData!).takeUnretainedValue()
      NSLog("Blueant hotkey fired")
      DispatchQueue.main.async { center.toggle?() }
      return noErr
    }, 1, &eventType, selfPtr, &handlerRef)
    guard status == noErr else {
      Unmanaged.passUnretained(self).release()
      NSLog("Blueant hotkey registration failed at InstallEventHandler: \(status)")
      return false
    }
    let hotKeyID = EventHotKeyID(signature: OSType(0x424C4E54), id: 1)
    let registerStatus = RegisterEventHotKey(BlueantHotkey.keyCode, BlueantHotkey.modifiers, hotKeyID,
                                             GetApplicationEventTarget(), 0, &hotKeyRef)
    guard registerStatus == noErr else {
      NSLog("Blueant hotkey registration failed at RegisterEventHotKey: \(registerStatus)")
      return false
    }
    installed = true
    NSLog("Blueant hotkey registered: keyCode %u, carbon modifier mask 0x%X", BlueantHotkey.keyCode, BlueantHotkey.modifiers)
    return true
  }

  func unregister() {
    guard installed else { return }
    if let ref = hotKeyRef {
      UnregisterEventHotKey(ref)
      hotKeyRef = nil
    }
    installed = false
  }
}

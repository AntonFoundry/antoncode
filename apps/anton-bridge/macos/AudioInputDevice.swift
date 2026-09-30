import AVFoundation
import CoreAudio
import Foundation

/// Microphone selection for Blueant's capture paths. Every path today taps
/// `AVAudioEngine.inputNode`, which always follows the system default; this
/// points that node's audio unit at a specific CoreAudio device so wake
/// listening, push-to-talk dictation, and the live voice session can share one
/// choice.
enum AudioInputDevice {
  struct Device {
    let uid: String
    let name: String
  }

  /// Every device that exposes at least one input channel, in CoreAudio order.
  static func all() -> [Device] {
    deviceIDs().compactMap { id in
      guard hasInput(id), let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
      return Device(uid: uid, name: name(of: id) ?? uid)
    }
  }

  /// The device every Blueant capture path should attach to: `uid` when it
  /// names a device with an open input stream, else the system default when it
  /// has one, else the first device in CoreAudio order that does.
  ///
  /// The system default is not trusted for having an input. An active
  /// Bluetooth headset publishes an aggregate device whose input stream is
  /// closed while its output stays open, and that aggregate remains the system
  /// default input; an `AVAudioEngine` input node attached to it reports a
  /// valid 44.1 kHz format, starts without error, and never renders a single
  /// tap buffer.
  static func resolveInput(uid: String?) -> AudioDeviceID? {
    if let uid, let id = deviceID(forUID: uid), hasInput(id) { return id }
    if let id = defaultInputDeviceID(), hasInput(id) { return id }
    return deviceIDs().first(where: hasInput)
  }

  /// True when the device exposes at least one input channel.
  static func hasInput(_ id: AudioDeviceID) -> Bool { inputChannels(of: id) > 0 }

  /// The CoreAudio device name, for diagnostics only.
  static func name(of id: AudioDeviceID) -> String? {
    stringProperty(id, kAudioObjectPropertyName)
  }

  /// Points `engine`'s input at the device `resolveInput` selects for `uid`
  /// (nil = the system default, subject to the same input-stream check). The
  /// property is set only when it actually moves the route: setting it again
  /// posts an `AVAudioEngineConfigurationChange`, and the always-on wake
  /// listener reads that as another client taking the device and rebuilds its
  /// tap — a self-sustaining loop that makes the microphone in-use indicator
  /// flicker. Must be called before the engine starts.
  static func apply(uid: String?, to engine: AVAudioEngine) {
    guard let unit = engine.inputNode.audioUnit else { return }
    guard let target = resolveInput(uid: uid) else {
      NSLog("Blueant audio: no audio device exposes an input stream")
      return
    }
    if let uid, let requested = deviceID(forUID: uid), requested != target {
      NSLog("Blueant audio: input device %@ has no usable input; using %@", uid, name(of: target) ?? "\(target)")
    }
    if currentDeviceID(of: engine) == target { return }
    var value = target
    let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0, &value,
                                      UInt32(MemoryLayout<AudioDeviceID>.size))
    if status != noErr { NSLog("Blueant audio: could not select the input device (status %d)", status) }
  }

  /// True when `engine`'s input already runs on the device `resolveInput`
  /// selects for `uid`. A configuration change that leaves this true did not
  /// move the route the caller asked for, so rebuilding the tap on it would
  /// only open and close the microphone again.
  static func isRouted(uid: String?, on engine: AVAudioEngine?) -> Bool {
    guard let engine, let current = currentDeviceID(of: engine) else { return false }
    return current == resolveInput(uid: uid)
  }

  /// The CoreAudio device the engine's input is currently running on.
  static func currentDeviceID(of engine: AVAudioEngine) -> AudioDeviceID? {
    guard let unit = engine.inputNode.audioUnit else { return nil }
    var id = 0 as AudioDeviceID
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                               kAudioUnitScope_Global, 0, &id, &size) == noErr else { return nil }
    return id
  }

  // MARK: CoreAudio plumbing

  private static func defaultInputAddress() -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                               mScope: kAudioObjectPropertyScopeGlobal,
                               mElement: kAudioObjectPropertyElementMain)
  }

  private static func deviceIDs() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
          size > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else {
      return []
    }
    return ids
  }

  private static func deviceID(forUID uid: String) -> AudioDeviceID? {
    deviceIDs().first { stringProperty($0, kAudioDevicePropertyDeviceUID) == uid }
  }

  private static func defaultInputDeviceID() -> AudioDeviceID? {
    var address = defaultInputAddress()
    var id = 0 as AudioDeviceID
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else {
      return nil
    }
    return id
  }

  private static func inputChannels(of id: AudioDeviceID) -> Int {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
                                             mScope: kAudioDevicePropertyScopeInput,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
  }

  private static func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString?
    let status = withUnsafeMutablePointer(to: &value) {
      AudioObjectGetPropertyData(id, &address, 0, nil, &size, $0)
    }
    guard status == noErr, let value else { return nil }
    return value as String
  }
}

/// The microphone uid from Blueant settings, kept where any capture path can
/// read it synchronously at engine-start time. The app writes it whenever the
/// settings store reports a change; engines read it as they open their tap.
enum BlueantAudioInput {
  private static let lock = NSLock()
  private static var uid: String?

  static var currentUID: String? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return uid
    }
    set {
      lock.lock()
      uid = newValue
      lock.unlock()
    }
  }
}

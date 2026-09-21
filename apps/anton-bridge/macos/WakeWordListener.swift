import AVFoundation
import Foundation

/// Ambient wake-word listener for Blueant (Phase 7b): an always-on input tap
/// feeds an energy voice-activity detector over a rolling 16 kHz mono ring
/// buffer; on speech onset the trailing window is decoded by the shared
/// whisper engine and matched against the wake keyword. Whisper runs only on
/// speech activity — never continuously — and the listener suspends while the
/// popup panel is visible, so it never taps the input alongside
/// SpeechController and never competes with the shared engine's dictation
/// jobs.
final class WakeWordListener {
  /// Tunables with safe defaults; the keyword is the only user-facing knob
  /// (settings), the rest stay fixed to keep the surface honest.
  struct Config {
    var keyword = "blueant"
    /// dB above the adaptive noise floor required for speech onset.
    var onsetMarginDB: Float = 9
    /// Absolute floor: rooms quieter than this never trigger.
    var absoluteFloorDB: Float = -42
    /// Consecutive speech taps (~1024 frames ≈ 21 ms each) required before
    /// onset fires, so keyboard clicks and door slams do not decode.
    var onsetTaps = 12
    /// Seconds of trailing audio decodes on onset.
    var decodeWindowSeconds = 3.0
    /// Rolling buffer length (caps memory at ~64 k floats).
    var ringSeconds = 6.0
    /// Ignore further triggers for this long after a fired wake (also covers
    /// the popup-opening moment so the keyword utterance does not re-fire).
    var cooldownSeconds: TimeInterval = 6
  }

  private let whisper: WhisperEngine
  private let onWake: () -> Void
  private var config = Config()

  private var audioEngine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private var ring: [Float] = []
  private var ringCapacity: Int
  /// Slow-moving estimate of ambient level; speech never raises it.
  private var noiseFloorDB: Float = -50
  private var speechStreak = 0
  private var decoding = false
  private var lastWake = Date.distantPast
  /// Settings-driven desired state; the engine runs only when desired and
  /// not suppressed (panel visible) and the microphone is authorized.
  private var desiredOn = false
  private var suppressed = false
  private(set) var active = false

  init(whisper: WhisperEngine, onWake: @escaping () -> Void) {
    self.whisper = whisper
    self.onWake = onWake
    ringCapacity = Int(config.ringSeconds * 16_000)
  }

  /// The keyword is matched case-insensitively against the decoded window.
  func updateKeyword(_ keyword: String) {
    let trimmed = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return }
    config.keyword = trimmed
  }

  /// Sets the settings-driven desired state and re-evaluates the engine.
  func setDesired(_ on: Bool) {
    desiredOn = on
    refresh()
  }

  /// Suppresses while the popup panel is visible (dictation or typing).
  func setSuppressed(_ on: Bool) {
    suppressed = on
    refresh()
  }

  private func refresh() {
    let shouldRun = desiredOn && !suppressed
      && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    if shouldRun { startEngine() } else { stopEngine() }
  }

  // MARK: Engine lifecycle

  private func startEngine() {
    guard !active else { return }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0 else { return }
    converter = AVAudioConverter(from: inputFormat, to: Self.whisperFormat)
    ring.removeAll(keepingCapacity: true)
    speechStreak = 0
    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      self?.ingest(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      NSLog("Blueant wake word: engine start failed \(error.localizedDescription)")
      return
    }
    audioEngine = engine
    active = true
    NSLog("Blueant wake word: listening for \"%@\"", config.keyword)
  }

  private func stopEngine() {
    guard active else { return }
    if let engine = audioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    audioEngine = nil
    converter = nil
    ring.removeAll(keepingCapacity: true)
    speechStreak = 0
    decoding = false
    active = false
  }

  // MARK: Audio path

  private func ingest(_ buffer: AVAudioPCMBuffer) {
    let level = Self.averagePowerDB(of: buffer)
    // Quiet input slowly lowers the floor; speech (louder) never raises it,
    // so the detector adapts to rooms without learning the user's voice as
    // noise.
    if level < noiseFloorDB {
      noiseFloorDB = noiseFloorDB * 0.95 + level * 0.05
    }
    appendToRing(buffer)
    if level >= max(noiseFloorDB + config.onsetMarginDB, config.absoluteFloorDB) {
      speechStreak += 1
    } else {
      speechStreak = 0
    }
    guard speechStreak >= config.onsetTaps, !decoding,
          Date().timeIntervalSince(lastWake) >= config.cooldownSeconds else { return }
    speechStreak = 0
    decodeTrailingWindow()
  }

  private func appendToRing(_ buffer: AVAudioPCMBuffer) {
    guard let converter,
          let converted = try? Self.convert(buffer, with: converter, to: Self.whisperFormat),
          converted.frameLength > 0 else { return }
    if let channel = converted.floatChannelData?[0] {
      ring.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
    }
    if ring.count > ringCapacity {
      ring.removeFirst(ring.count - ringCapacity)
    }
  }

  /// Decodes the trailing ring window and fires `onWake` when the keyword
  /// appears in the transcript. Decodes are serialized by the shared
  /// engine's queue; `decoding` keeps one window in flight.
  private func decodeTrailingWindow() {
    let windowSamples = Int(config.decodeWindowSeconds * 16_000)
    guard ring.count >= windowSamples / 2 else { return }
    let window = Array(ring.suffix(windowSamples))
    decoding = true
    whisper.transcribe(window) { [weak self] text in
      guard let self else { return }
      self.decoding = false
      let normalized = text.lowercased()
      guard normalized.contains(self.config.keyword) else { return }
      self.lastWake = Date()
      NSLog("Blueant wake word: triggered")
      self.onWake()
    }
  }

  // MARK: Helpers

  private static let whisperFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!

  /// RMS power of the first channel in dB, clamped to [-60, 0] — same
  /// metering convention as SpeechController.
  private static func averagePowerDB(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -60 }
    var sum: Float = 0
    for frame in 0..<Int(buffer.frameLength) {
      let sample = channel[frame]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(buffer.frameLength))
    return min(0, max(-60, 20 * log10(max(rms, 1e-6))))
  }

  private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      throw NSError(domain: "WakeWordListener", code: 1)
    }
    var delivered = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if delivered {
        status.pointee = .noDataNow
        return nil
      }
      delivered = true
      status.pointee = .haveData
      return buffer
    }
    if let error { throw error }
    return converted
  }
}

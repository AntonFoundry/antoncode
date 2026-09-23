import AVFoundation
import Foundation
import os

/// Ambient wake-word listener for Blueant (Phase 7b): an always-on input tap
/// feeds an energy voice-activity detector over a rolling 16 kHz mono ring
/// buffer; on speech onset the trailing window is decoded by the selected
/// local transcription engine and matched against the wake keyword. Decoding
/// runs only on speech activity — never continuously — and the listener
/// suspends while the popup panel is visible, so it never taps the input alongside
/// SpeechController and never competes with the shared engine's dictation
/// jobs.
final class WakeWordListener {
  private let logger = Logger(subsystem: "dev.antoncode.anton", category: "blueant.wake-word")
  /// Tunables with safe defaults; the keyword is the only user-facing knob
  /// (settings), the rest stay fixed to keep the surface honest.
  struct Config {
    var keyword = "blueant"
    /// ASR renders the proper noun inconsistently (measured: "Bluint" on
    /// whisper small, "Bluent" on parakeet TDT); any variant confirms the
    /// wake. Derived from the keyword, not user-configured.
    var keywordVariants: [String] { WakeWordListener.variants(of: keyword) }
    /// dB above the adaptive noise floor required for speech onset.
    var onsetMarginDB: Float = 9
    /// Absolute floor: rooms quieter than this never trigger.
    var absoluteFloorDB: Float = -42
    /// Consecutive speech taps (~1024 frames ≈ 21 ms each) required before
    /// onset fires, so keyboard clicks and door slams do not decode.
    var onsetTaps = 12
    /// Seconds of trailing audio decoded after speech onset.
    var decodeWindowSeconds = 3.0
    /// Lets the complete wake phrase enter the rolling buffer before decoding.
    var decodeDelaySeconds: TimeInterval = 0.9
    /// Rolling buffer length (caps memory at ~64 k floats).
    var ringSeconds = 6.0
    /// Ignore further triggers for this long after a fired wake (also covers
    /// the popup-opening moment so the keyword utterance does not re-fire).
    var cooldownSeconds: TimeInterval = 6
  }

  private let transcriber: TranscriptionEngine
  private let fallbackTranscriber: TranscriptionEngine?
  private let onWake: () -> Void
  private var config = Config()

  private var audioEngine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private var ring: [Float] = []
  private var ringCapacity: Int
  private let ringLock = NSLock()
  /// Slow-moving estimate of ambient level.
  private var noiseFloorDB: Float = -50
  private var noiseFloorInitialized = false
  private var speechStreak = 0
  private var decoding = false
  private var lastWake = Date.distantPast
  /// Settings-driven desired state; the engine runs only when desired and
  /// not suppressed (panel visible) and the microphone is authorized.
  private var desiredOn = false
  private var suppressed = false
  private var permissionRequestInFlight = false
  private(set) var active = false
  private var audioObservers: [NSObjectProtocol] = []

  /// Variants a decoder plausibly emits for the keyword: the joined form,
  /// the two-word split, and the vowel-swaps both shipped engines produce.
  static func variants(of keyword: String) -> [String] {
    let lowered = keyword.lowercased()
    let compact = lowered.filter { $0.isLetter || $0.isNumber }
    var result = Set([compact])
    if compact == "blueant" {
      result.insert("bluent")
      result.insert("bluint")
      result.insert("blueaunt")
      result.insert("blueand")
      result.insert("blueend")
      result.insert("bluand")
    }
    result.insert(lowered.replacingOccurrences(of: "ea", with: "i"))
    result.insert(lowered.replacingOccurrences(of: "ea", with: "e"))
    return Array(result.filter { $0.count >= 4 })
  }

  init(transcriber: TranscriptionEngine, fallbackTranscriber: TranscriptionEngine? = nil,
       onWake: @escaping () -> Void) {
    self.transcriber = transcriber
    self.fallbackTranscriber = fallbackTranscriber
    self.onWake = onWake
    ringCapacity = Int(config.ringSeconds * 16_000)
    let center = NotificationCenter.default
    audioObservers = [
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
        self?.restartAfterAudioChange()
      },
    ]
  }

  deinit {
    for observer in audioObservers { NotificationCenter.default.removeObserver(observer) }
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
    guard desiredOn && !suppressed else {
      stopEngine()
      return
    }
    let authorization = AVCaptureDevice.authorizationStatus(for: .audio)
    switch authorization {
    case .authorized:
      startEngine()
    case .notDetermined where !permissionRequestInFlight:
      permissionRequestInFlight = true
      AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
        DispatchQueue.main.async {
          guard let self else { return }
          self.permissionRequestInFlight = false
          self.refresh()
        }
      }
    default:
      NSLog("Blueant wake word: microphone authorization is %@", String(describing: authorization))
      stopEngine()
    }
  }

  /// Recreate the tap after another audio client changes the shared device or
  /// CoreAudio resets its media services. Without this, `active` can remain
  /// true while the old engine has stopped delivering microphone buffers.
  private func restartAfterAudioChange() {
    guard desiredOn, !suppressed else { return }
    stopEngine()
    DispatchQueue.main.async { [weak self] in
      guard let self, self.desiredOn, !self.suppressed else { return }
      self.startEngine()
    }
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
    logger.info("listener active; engine=\(self.transcriber.engineName, privacy: .public); keyword=\(self.config.keyword, privacy: .public)")
  }

  private func stopEngine() {
    guard active else { return }
    if let engine = audioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    audioEngine = nil
    converter = nil
    ringLock.lock()
    ring.removeAll(keepingCapacity: true)
    ringLock.unlock()
    speechStreak = 0
    decoding = false
    noiseFloorInitialized = false
    active = false
    transcriber.cancelAll()
  }

  // MARK: Audio path

  private func ingest(_ buffer: AVAudioPCMBuffer) {
    let level = Self.averagePowerDB(of: buffer)
    if !noiseFloorInitialized {
      noiseFloorDB = min(max(level, -60), -35)
      noiseFloorInitialized = true
    } else if level < noiseFloorDB {
      noiseFloorDB = noiseFloorDB * 0.95 + level * 0.05
    } else {
      // Slowly adapt upward to ambient room noise; rate is slow enough that
      // speech utterances (1-3 seconds) do not significantly raise the floor.
      noiseFloorDB = noiseFloorDB * 0.998 + min(level, -20) * 0.002
    }
    appendToRing(buffer)
    if level >= max(noiseFloorDB + config.onsetMarginDB, config.absoluteFloorDB) {
      speechStreak += 1
      if speechStreak == config.onsetTaps {
        logger.info("speech detected; level=\(level, privacy: .public) dB; noiseFloor=\(self.noiseFloorDB, privacy: .public) dB; decoding next audio window")
      }
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
      ringLock.lock()
      ring.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
      if ring.count > ringCapacity {
        ring.removeFirst(ring.count - ringCapacity)
      }
      ringLock.unlock()
    }
  }

  /// Decodes the trailing ring window and fires `onWake` when the keyword
  /// appears in the transcript. Decodes are serialized by the shared
  /// engine's queue; `decoding` keeps one window in flight.
  private func decodeTrailingWindow() {
    let windowSamples = Int(config.decodeWindowSeconds * 16_000)
    guard !decoding else { return }
    decoding = true
    // The listener may have just started, so the ring can contain less than a
    // useful phrase window at speech onset. Wait for the shorter minimum
    // window rather than dropping this wake attempt before transcription.
    let minimumSamples = windowSamples / 2
    ringLock.lock()
    let currentRingCount = ring.count
    ringLock.unlock()
    let missingSamples = max(0, minimumSamples - currentRingCount)
    let bufferDelay = Double(missingSamples) / 16_000
    let delay = max(config.decodeDelaySeconds, bufferDelay)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      self?.decodeCompletedWindow(windowSamples: windowSamples)
    }
  }

  private func decodeCompletedWindow(windowSamples: Int) {
    guard !suppressed else {
      decoding = false
      return
    }
    ringLock.lock()
    let window = Array(ring.suffix(windowSamples))
    ringLock.unlock()
    guard window.count >= windowSamples / 2 else {
      logger.info("wake decode skipped; only \(window.count, privacy: .public) samples buffered")
      decoding = false
      return
    }
    logger.info("sending \(window.count, privacy: .public) samples to \(self.transcriber.engineName, privacy: .public)")
    transcriber.transcribe(window) { [weak self] text in
      guard let self else { return }
      if self.acceptWake(text, engine: self.transcriber.engineName) { return }
      guard let fallback = self.fallbackTranscriber,
            fallback.engineName != self.transcriber.engineName else {
        self.decoding = false
        return
      }
      self.logger.info("primary wake decode missed; retrying with \(fallback.engineName, privacy: .public)")
      fallback.transcribe(window) { [weak self] fallbackText in
        guard let self else { return }
        _ = self.acceptWake(fallbackText, engine: fallback.engineName)
        self.decoding = false
      }
    }
  }

  private func acceptWake(_ text: String, engine: String) -> Bool {
    let normalized = text.lowercased()
    let compact = normalized.filter { $0.isLetter || $0.isNumber }
    let matched = config.keywordVariants.contains(where: { compact.contains($0) })
    NSLog("Blueant wake word: %@ decoded window \"%@\" wakeMatch=%@", engine, text, matched.description)
    logger.info("decoded engine=\(engine, privacy: .public); text=\(text, privacy: .public); wakeMatch=\(matched, privacy: .public)")
    guard matched else { return false }
    decoding = false
    lastWake = Date()
    NSLog("Blueant wake word: triggered")
    onWake()
    return true
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

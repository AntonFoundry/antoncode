import AVFoundation
import Speech

/// Push-to-talk speech recognition for Blueant. Primary engine is
/// whisper.cpp (Metal, see WhisperEngine): the AVAudioEngine input tap
/// accumulates 16 kHz mono samples, partials re-transcribe the growing buffer
/// every ~1.2 s of new audio, and stop() transcribes the full buffer as the
/// final result. If the whisper model is missing or context init fails, the
/// controller transparently falls back to on-device SFSpeechRecognizer. Owns
/// the full recognition lifecycle — permissions, tap install, task teardown —
/// and guarantees cleanup on every exit path, including the one-minute
/// SFSpeechRecognizer limit (auto-stop at ~55 s) and the panel hiding
/// mid-dictation. macOS has no AVAudioSession; the engine runs directly
/// against the default input device.
final class SpeechController: NSObject {
  struct Callbacks {
    /// Interim transcripts while recognition runs.
    var onPartial: ((String) -> Void)?
    /// Average input power in dB, clamped to [-60, 0], for a level meter.
    var onLevel: ((Float) -> Void)?
    /// Final transcript when a session ends cleanly (stop, or auto-stop).
    var onFinish: ((String) -> Void)?
    /// Recognition failed or became unavailable; degrade to typing.
    var onFailure: ((String) -> Void)?
  }

  private var audioEngine: AVAudioEngine?
  private var recognizer: SFSpeechRecognizer?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var callbacks = Callbacks()
  private var autoStopTimer: Timer?
  private(set) var isListening = false

  private static let autoStopInterval: TimeInterval = 55

  // Whisper accumulation state (primary engine path).
  private var whisper: WhisperEngine?
  private var whisperSamples: [Float] = []
  private var whisperConverter: AVAudioConverter?
  private var lastPartialSampleCount = 0
  private var transcribing = false
  private var awaitingFinal = false
  /// whisper.cpp consumes 16 kHz mono buffers; ~1.2 s of new audio triggers
  /// the next incremental partial transcription.
  private static let partialIntervalSamples = 19_200
  /// Minimum buffered audio before the first partial is attempted.
  private static let minimumPartialSamples = 8_000

  // MARK: Permissions

  /// Requests speech recognition AND microphone authorization, then reports
  /// the combined result; `denial` names the specific permission that was
  /// refused when not granted.
  static func requestPermissions(onResult: @escaping (_ granted: Bool, _ denial: String?) -> Void) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
      if speechStatus != .authorized {
        DispatchQueue.main.async { onResult(false, "speech recognition") }
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { micGranted in
        DispatchQueue.main.async {
          if micGranted {
            onResult(true, nil)
          } else {
            onResult(false, "microphone")
          }
        }
      }
    }
  }

  // MARK: Start / stop

  /// Starts listening. All callbacks fire on the main queue.
  func start(callbacks: Callbacks) {
    guard !isListening else { return }
    self.callbacks = callbacks
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      callbacks.onFailure?("Microphone/Speech permission denied — type instead")
      return
    }

    if whisper == nil { whisper = WhisperEngine() }
    if let engine = whisper, engine.available {
      NSLog("Blueant STT engine: whisper.cpp (Metal)")
      startWhisper(engine)
    } else {
      NSLog("Blueant STT engine: SFSpeechRecognizer fallback")
      startSFSpeech()
    }
  }

  /// Primary path: whisper.cpp transcription over an accumulated 16 kHz buffer.
  private func startWhisper(_ engine: WhisperEngine) {
    guard let audio = buildAudioEngine(tapHandler: { [weak self] buffer, _ in
      guard let self else { return }
      self.appendWhisperSamples(from: buffer)
      let power = Self.averagePower(of: buffer)
      if let onLevel = self.callbacks.onLevel {
        DispatchQueue.main.async { onLevel(power) }
      }
      self.maybeTranscribePartial()
    }) else {
      callbacks.onFailure?("No microphone input — type instead")
      return
    }
    audioEngine = audio
    whisperSamples = []
    lastPartialSampleCount = 0
    transcribing = false
    awaitingFinal = false
    isListening = true

    // whisper has no per-task limit, but stop cleanly before the panel's
    // one-minute expectation like the SFSpeech path does.
    autoStopTimer = Timer.scheduledTimer(withTimeInterval: Self.autoStopInterval, repeats: false) { [weak self] _ in
      self?.stop()
    }
  }

  /// Fallback path: on-device SFSpeechRecognizer fed by the same input tap.
  private func startSFSpeech() {
    let authStatus = SFSpeechRecognizer.authorizationStatus()
    guard authStatus == .authorized else {
      callbacks.onFailure?("Microphone/Speech permission denied — type instead")
      return
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
      callbacks.onFailure?("Speech recognition unavailable — type instead")
      return
    }
    self.recognizer = recognizer

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    }

    guard let engine = buildAudioEngine(tapHandler: { [weak self] buffer, _ in
      guard let self else { return }
      request.append(buffer)
      let power = Self.averagePower(of: buffer)
      if let onLevel = self.callbacks.onLevel {
        DispatchQueue.main.async { onLevel(power) }
      }
    }) else {
      callbacks.onFailure?("No microphone input — type instead")
      return
    }

    audioEngine = engine
    recognitionRequest = request
    isListening = true

    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self else { return }
      DispatchQueue.main.async {
        if let result {
          let text = result.bestTranscription.formattedString
          if result.isFinal {
            self.finish(withFinal: text)
          } else if self.isListening {
            self.callbacks.onPartial?(text)
          }
        } else if error != nil, self.isListening {
          // The task errored (timeout, interruption): keep whatever partial
          // we have and treat it as the final transcript.
          self.stop()
        }
      }
    }

    // SFSpeechRecognizer caps a task at ~1 minute; stop cleanly just before.
    autoStopTimer = Timer.scheduledTimer(withTimeInterval: Self.autoStopInterval, repeats: false) { [weak self] _ in
      self?.stop()
    }
  }

  /// Stops recognition and reports the best transcript so far as final.
  func stop() {
    guard isListening else { return }
    if recognitionRequest != nil {
      recognitionRequest?.endAudio()
      recognitionTask?.finish()
      teardown()
      return
    }
    // Whisper path: re-transcribe the full buffer as the final result. The
    // generation bump inside transcribe() drops any in-flight partial job.
    stopAudioTap()
    guard let whisper, awaitingFinal == false else { return }
    awaitingFinal = true
    let samples = whisperSamples
    whisper.transcribe(samples) { [weak self] text in
      self?.finish(withFinal: text)
    }
  }

  /// Tears everything down without reporting a final transcript (panel hid).
  func abort() {
    guard isListening else { return }
    whisper?.cancelAll()
    recognitionTask?.cancel()
    teardown()
  }

  // MARK: Audio plumbing

  /// Builds the shared AVAudioEngine with a tap on the default input. The tap
  /// handler receives native-format buffers (level metering) and each path
  /// converts or appends as needed.
  private func buildAudioEngine(tapHandler: @escaping (AVAudioPCMBuffer, AVAudioTime) -> Void) -> AVAudioEngine? {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0 else { return nil }
    if whisperConverter == nil {
      whisperConverter = Self.makeConverter(from: inputFormat)
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat, block: tapHandler)
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      return nil
    }
    return engine
  }

  /// Removes the tap and stops the engine without touching per-engine state.
  private func stopAudioTap() {
    autoStopTimer?.invalidate()
    autoStopTimer = nil
    if let engine = audioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    audioEngine = nil
  }

  /// Converts a native-format tap buffer to 16 kHz mono Float32 and appends
  /// it to the whisper accumulation buffer.
  private func appendWhisperSamples(from buffer: AVAudioPCMBuffer) {
    guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
          let converter = whisperConverter else { return }
    let ratio = 16_000 / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var delivered = false
    var conversionError: NSError?
    converter.convert(to: converted, error: &conversionError) { _, inputStatus in
      if delivered {
        inputStatus.pointee = .noDataNow
        return nil
      }
      delivered = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if conversionError != nil || converted.frameLength == 0 { return }
    if let channel = converted.floatChannelData?[0] {
      whisperSamples.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
    }
  }

  /// Re-transcribes the accumulated buffer as a partial when enough new audio
  /// has arrived and no transcription is in flight.
  private func maybeTranscribePartial() {
    guard isListening, !awaitingFinal, !transcribing else { return }
    guard whisperSamples.count >= Self.minimumPartialSamples,
          whisperSamples.count - lastPartialSampleCount >= Self.partialIntervalSamples else { return }
    guard let whisper else { return }
    transcribing = true
    lastPartialSampleCount = whisperSamples.count
    let samples = whisperSamples
    whisper.transcribe(samples) { [weak self] text in
      guard let self else { return }
      transcribing = false
      // A stop() re-transcription may have superseded this partial.
      if isListening, !awaitingFinal, !text.isEmpty {
        callbacks.onPartial?(text)
      }
    }
  }

  // MARK: Teardown

  private func teardown() {
    stopAudioTap()
    recognitionRequest = nil
    recognitionTask = nil
    whisperSamples = []
    whisperConverter = nil
    lastPartialSampleCount = 0
    transcribing = false
    awaitingFinal = false
    isListening = false
  }

  /// Single completion funnel: idempotent, reports final once.
  private func finish(withFinal text: String) {
    guard isListening else { return }
    teardown()
    callbacks.onFinish?(text)
    callbacks = Callbacks()
  }

  /// RMS power of the first channel in dB, clamped to [-60, 0].
  private static func averagePower(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -60 }
    var sum: Float = 0
    for frame in 0..<Int(buffer.frameLength) {
      let sample = channel[frame]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(buffer.frameLength))
    return min(0, max(-60, 20 * log10(max(rms, 1e-6))))
  }

  /// Converter from a native input format to the 16 kHz mono Float32 format
  /// whisper.cpp expects; created once per session from the tap format.
  private static func makeConverter(from format: AVAudioFormat) -> AVAudioConverter? {
    guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
      return nil
    }
    return AVAudioConverter(from: format, to: target)
  }
}

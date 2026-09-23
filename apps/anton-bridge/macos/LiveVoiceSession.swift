import AVFoundation
import Accelerate
import Cocoa

/// Low-latency Blueant voice session. Audio stays on the local microphone and
/// speaker while the bridge owns the provider credential and live model.
final class BlueantLiveVoiceSession: NSObject {
  struct Callbacks {
    var onConnecting: (() -> Void)?
    var onReady: (() -> Void)?
    var onTranscript: ((String, String, Bool) -> Void)?
    var onLocalTranscript: ((String, Bool) -> Void)?
    var onAudioLevel: ((Float) -> Void)?
    var onSpectrum: (([Float]) -> Void)?
    var onText: ((String) -> Void)?
    var onInterrupted: (() -> Void)?
    var onTurnComplete: (() -> Void)?
    var onFailure: ((String) -> Void)?
    var onToolCall: ((String, String, [String: Any]) -> Void)?
  }

  private let audioEngine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var inputConverter: AVAudioConverter?
  private var socket: URLSessionWebSocketTask?
  private var urlSession: URLSession?
  private var callbacks = Callbacks()
  private var setupTimeout: DispatchWorkItem?
  // Live voice runs while the speaker is active and the wake listener may
  // have just released the microphone. Keep its diagnostic transcript on the
  // isolated Whisper context; Parakeet's native ggml context can abort the
  // host process when another audio path is using Metal.
  private var transcriber: TranscriptionEngine = WhisperEngine.wake
  private var localSamples: [Float] = []
  private var localConverter: AVAudioConverter?
  private var lastPartialSampleCount = 0
  private var localTranscribing = false
  private var pendingFinalTranscription = false
  private var localSpeechSeen = false
  private var localSpeechStartedAt: Date?
  private var endingLocalTurn = false
  /// Prevent the speaker's response from being sent back to Gemini as a new
  /// user turn. The input graph remains active for metering, but response
  /// playback gates the microphone upload until its queued audio is consumed.
  private var responseBuffersQueued = 0
  private var bargeInFrames = 0
  private var lastResponseAudioPlayedAt = Date.distantPast
  private let responseStateLock = NSLock()
  private let bargeInThresholdDB: Float = -32
  private let bargeInRequiredFrames = 2
  private let echoHangoverSeconds: TimeInterval = 0.35
  private var lastLevelLogAt = Date.distantPast
  private var localSilenceWork: DispatchWorkItem?
  private let fftSize = 512
  private let fftSetup = vDSP_create_fftsetup(9, FFTRadix(kFFTRadix2))
  private let spectrumQueue = DispatchQueue(label: "dev.antoncode.blueant.spectrum", qos: .userInteractive)
  private var spectrumSamples: [Float] = []
  private static let hannWindow = (0..<512).map { index in
    0.5 - 0.5 * cos(2 * .pi * Float(index) / 511)
  }
  private(set) var isRunning = false

  func setTranscriber(_ transcriber: TranscriptionEngine) {
    guard !isRunning else { return }
    self.transcriber = transcriber
  }

  func start(callbacks: Callbacks) {
    guard !isRunning else { return }
    self.callbacks = callbacks
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      NSLog("Blueant live voice: microphone permission denied")
      DispatchQueue.main.async { self.callbacks.onFailure?("Microphone permission denied") }
      return
    }
    guard let url = URL(string: "ws://127.0.0.1:3742/bridge/api/voice/live") else { return }
    let session = URLSession(configuration: .ephemeral)
    urlSession = session
    socket = session.webSocketTask(with: url)
    socket?.resume()
    isRunning = true
    NSLog("Blueant live voice: connecting to local bridge")
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.isRunning else { return }
      NSLog("Blueant live voice: Gemini setup timed out")
      self.callbacks.onFailure?("Gemini Live setup timed out")
    }
    setupTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
    localSamples.removeAll(keepingCapacity: true)
    spectrumQueue.async { [weak self] in self?.spectrumSamples.removeAll(keepingCapacity: true) }
    lastPartialSampleCount = 0
    localTranscribing = false
    pendingFinalTranscription = false
    localSpeechSeen = false
    localSpeechStartedAt = nil
    endingLocalTurn = false
    installAudio()
    guard isRunning else { return }
    receive()
  }

  func stop() {
    guard isRunning else { return }
    isRunning = false
    setupTimeout?.cancel()
    setupTimeout = nil
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
    player.stop()
    player.reset()
    responseStateLock.lock()
    responseBuffersQueued = 0
    bargeInFrames = 0
    lastResponseAudioPlayedAt = Date.distantPast
    responseStateLock.unlock()
    transcriber.cancelAll()
    localSilenceWork?.cancel()
    localSilenceWork = nil
    localSamples.removeAll(keepingCapacity: true)
    localSpeechStartedAt = nil
    endingLocalTurn = false
    spectrumQueue.async { [weak self] in self?.spectrumSamples.removeAll(keepingCapacity: true) }
    localConverter = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    urlSession?.invalidateAndCancel()
    urlSession = nil
    callbacks = Callbacks()
  }

  deinit {
    if let fftSetup { vDSP_destroy_fftsetup(fftSetup) }
  }

  private func installAudio(allowVoiceProcessing: Bool = true) {
    let input = audioEngine.inputNode
    if allowVoiceProcessing, !input.isVoiceProcessingEnabled {
      do {
        try input.setVoiceProcessingEnabled(true)
        NSLog("Blueant live voice: acoustic echo cancellation enabled")
      } catch {
        NSLog("Blueant live voice: acoustic echo cancellation unavailable: %@", error.localizedDescription)
      }
    }
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0,
          let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: 16_000, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: inputFormat, to: target) else {
      DispatchQueue.main.async { [weak self] in self?.callbacks.onFailure?("No microphone input") }
      return
    }
    inputConverter = converter
    localConverter = converter
    guard ensurePlaybackGraph() else {
      DispatchQueue.main.async { [weak self] in self?.callbacks.onFailure?("No audio playback output") }
      return
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      self?.send(buffer: buffer, converter: converter, target: target)
    }
    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      if allowVoiceProcessing, input.isVoiceProcessingEnabled {
        NSLog("Blueant live voice: voice-processing graph failed; retrying standard audio: %@",
              error.localizedDescription)
        input.removeTap(onBus: 0)
        audioEngine.stop()
        audioEngine.reset()
        do {
          try input.setVoiceProcessingEnabled(false)
          installAudio(allowVoiceProcessing: false)
          return
        } catch {
          NSLog("Blueant live voice: could not restore standard audio: %@", error.localizedDescription)
        }
      }
      NSLog("Blueant live voice: audio engine failed to start: %@", error.localizedDescription)
      DispatchQueue.main.async { [weak self] in
        self?.callbacks.onFailure?("Audio engine failed to start: \(error.localizedDescription)")
      }
      return
    }
    player.play()
  }

  /// Reconnects the player after an audio-engine reset. `AVAudioPlayerNode`
  /// can remain attached while its output connection has been cleared, so
  /// checking only `player.engine` is insufficient.
  private func ensurePlaybackGraph() -> Bool {
    guard let output = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: 24_000, channels: 1, interleaved: false) else {
      return false
    }
    if player.engine == nil {
      audioEngine.attach(player)
    } else {
      audioEngine.disconnectNodeOutput(player)
    }
    audioEngine.connect(player, to: audioEngine.mainMixerNode, format: output)
    player.volume = 1
    audioEngine.mainMixerNode.outputVolume = 1
    return true
  }

  private func send(buffer: AVAudioPCMBuffer, converter: AVAudioConverter, target: AVAudioFormat) {
    guard isRunning else { return }
    responseStateLock.lock()
    let isActivelyPlaying = responseBuffersQueued > 0
    let timeSincePlayback = Date().timeIntervalSince(lastResponseAudioPlayedAt)
    let isEchoHangover = !isActivelyPlaying && timeSincePlayback < echoHangoverSeconds
    let responseIsActive = isActivelyPlaying || isEchoHangover
    responseStateLock.unlock()
    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var delivered = false
    var conversionError: NSError?
    converter.convert(to: converted, error: &conversionError) { _, status in
      if delivered { status.pointee = .noDataNow; return nil }
      delivered = true
      status.pointee = .haveData
      return buffer
    }
    guard conversionError == nil, converted.frameLength > 0,
          let channel = converted.floatChannelData?[0] else { return }
    let sum = (0..<Int(converted.frameLength)).reduce(Float.zero) { partial, index in
      partial + channel[index] * channel[index]
    }
    let db = 20 * log10(max(sqrt(sum / max(1, Float(converted.frameLength))), 1e-6))
    DispatchQueue.main.async { [weak self] in self?.callbacks.onAudioLevel?(db) }
    let incomingSamples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
    spectrumQueue.async { [weak self] in
      guard let self, self.isRunning,
            let bands = self.analyzeSpectrum(samples: incomingSamples) else { return }
      DispatchQueue.main.async { [weak self] in self?.callbacks.onSpectrum?(bands) }
    }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.isRunning else { return }
      if !responseIsActive {
        self.consumeLocalAudio(samples: incomingSamples, db: db)
      }
    }
    // Keep metering and local diagnostics active, but drop ordinary speaker
    // bleed during playback and the immediate reverberation hangover.
    if responseIsActive {
      if db > bargeInThresholdDB {
        responseStateLock.lock()
        bargeInFrames += 1
        let shouldBargeIn = isActivelyPlaying && (bargeInFrames >= bargeInRequiredFrames)
        if shouldBargeIn {
          responseBuffersQueued = 0
          bargeInFrames = 0
          lastResponseAudioPlayedAt = Date.distantPast
        }
        responseStateLock.unlock()
        if shouldBargeIn {
          NSLog("Blueant live voice: local speech interrupted response (%.1f dB)", db)
          player.stop()
          player.reset()
          player.play()
          DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.localSamples.removeAll(keepingCapacity: true)
            self.localSpeechSeen = false
            self.localSpeechStartedAt = nil
            self.callbacks.onInterrupted?()
          }
        } else if !isActivelyPlaying {
          // Inside hangover window: speech above threshold is real user speech starting a new turn.
        } else {
          return
        }
      } else {
        responseStateLock.lock()
        bargeInFrames = 0
        responseStateLock.unlock()
        return
      }
    }
    var pcm = Data(count: Int(converted.frameLength) * MemoryLayout<Int16>.size)
    pcm.withUnsafeMutableBytes { destination in
      for index in 0..<Int(converted.frameLength) {
        let sample = Int16(max(-1, min(1, channel[index])) * Float(Int16.max))
        let bits = UInt16(bitPattern: sample)
        let offset = index * MemoryLayout<Int16>.size
        destination[offset] = UInt8(bits & 0xff)
        destination[offset + 1] = UInt8(bits >> 8)
      }
    }
    let message: [String: Any] = [
      "type": "audio",
      "data": pcm.base64EncodedString(),
      "mimeType": "audio/pcm;rate=16000",
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: message),
          let text = String(data: data, encoding: .utf8) else { return }
    socket?.send(.string(text)) { error in
      if let error {
        NSLog("Blueant live voice: audio send failed: %@", error.localizedDescription)
      }
    }
  }

  /// Produces 50 logarithmically spaced frequency bands from the microphone.
  private func analyzeSpectrum(samples incoming: [Float]) -> [Float]? {
    spectrumSamples.append(contentsOf: incoming)
    guard spectrumSamples.count >= fftSize, let fftSetup else { return nil }

    let window = Array(spectrumSamples.prefix(fftSize))
    spectrumSamples.removeFirst(fftSize / 2)
    var samples = window
    for index in samples.indices {
      samples[index] *= Self.hannWindow[index]
    }
    var real = [Float](repeating: 0, count: fftSize / 2)
    var imaginary = [Float](repeating: 0, count: fftSize / 2)
    var magnitudes = [Float](repeating: 0, count: fftSize / 2)
    samples.withUnsafeBufferPointer { sampleBuffer in
      real.withUnsafeMutableBufferPointer { realBuffer in
        imaginary.withUnsafeMutableBufferPointer { imaginaryBuffer in
          var split = DSPSplitComplex(realp: realBuffer.baseAddress!, imagp: imaginaryBuffer.baseAddress!)
          sampleBuffer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftSize / 2) { complex in
            vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(fftSize / 2))
          }
          vDSP_fft_zrip(fftSetup, &split, 1, 9, FFTDirection(FFT_FORWARD))
          magnitudes.withUnsafeMutableBufferPointer { magnitudeBuffer in
            vDSP_zvabs(&split, 1, magnitudeBuffer.baseAddress!, 1, vDSP_Length(fftSize / 2))
          }
        }
      }
    }

    let lowFrequency: Float = 90
    let highFrequency: Float = 7_600
    let binFrequency = 16_000 / Float(fftSize)
    return (0..<50).map { index in
      let startProgress = Float(index) / 50
      let endProgress = Float(index + 1) / 50
      let low = Int(lowFrequency * pow(highFrequency / lowFrequency, startProgress) / binFrequency)
      let high = Int(lowFrequency * pow(highFrequency / lowFrequency, endProgress) / binFrequency)
      let lowerBin = min(max(1, low), magnitudes.count - 1)
      let upperBin = min(max(lowerBin + 1, high), magnitudes.count)
      let peak = magnitudes[lowerBin..<upperBin].max() ?? 0
      let normalized = min(1, peak * (2 / Float(fftSize)) * 24)
      return pow(normalized, 0.56)
    }
  }

  private func consumeLocalAudio(samples: [Float], db: Float) {
    guard !endingLocalTurn else { return }
    if Date().timeIntervalSince(lastLevelLogAt) >= 3 {
      lastLevelLogAt = Date()
      NSLog("Blueant live voice: microphone level %.1f dB, speech=%@", db,
            localSpeechSeen ? "yes" : "no")
    }
    localSamples.append(contentsOf: samples)
    if db > -50 {
      localSpeechSeen = true
      if localSpeechStartedAt == nil { localSpeechStartedAt = Date() }
      localSilenceWork?.cancel()
      localSilenceWork = nil
    } else if localSpeechSeen, localSilenceWork == nil {
      let work = DispatchWorkItem { [weak self] in
        guard let self, self.isRunning else { return }
        self.finishLocalTurn()
      }
      localSilenceWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.65, execute: work)
    }
    if let startedAt = localSpeechStartedAt, Date().timeIntervalSince(startedAt) >= 10 {
      finishLocalTurn()
      return
    }
    if localSamples.count - lastPartialSampleCount >= 19_200 {
      lastPartialSampleCount = localSamples.count
      transcribeLocalIfNeeded(final: false)
    }
  }

  private func finishLocalTurn() {
    guard isRunning, !endingLocalTurn else { return }
    endingLocalTurn = true
    localSilenceWork?.cancel()
    localSilenceWork = nil
    NSLog("Blueant live voice: local speech ended; sending audio turn")
    sendAudioStreamEnd()
    transcribeLocalIfNeeded(final: true)
  }

  private func transcribeLocalIfNeeded(final: Bool) {
    if final { pendingFinalTranscription = true }
    guard !localTranscribing, !localSamples.isEmpty else { return }
    localTranscribing = true
    let samples = localSamples
    transcriber.transcribe(samples) { [weak self] text in
      guard let self else { return }
      self.localTranscribing = false
      if self.pendingFinalTranscription && !final {
        self.transcribeLocalIfNeeded(final: true)
        return
      }
      let finalResult = final
      self.pendingFinalTranscription = false
      if !text.isEmpty {
        DispatchQueue.main.async { [weak self] in self?.callbacks.onLocalTranscript?(text, finalResult) }
      }
      if finalResult {
        self.localSamples.removeAll(keepingCapacity: true)
        self.lastPartialSampleCount = 0
        self.localSpeechSeen = false
        self.localSpeechStartedAt = nil
        self.endingLocalTurn = false
        self.localSilenceWork?.cancel()
        self.localSilenceWork = nil
      }
      if self.pendingFinalTranscription { self.transcribeLocalIfNeeded(final: true) }
    }
  }

  func sendLocalTranscript(_ text: String) {
    guard isRunning, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let data = try? JSONSerialization.data(withJSONObject: ["type": "localTranscript", "text": text]),
          let message = String(data: data, encoding: .utf8) else { return }
    socket?.send(.string(message)) { _ in }
  }

  private func sendAudioStreamEnd() {
    guard isRunning,
          let data = try? JSONSerialization.data(withJSONObject: ["type": "audioStreamEnd"]),
          let message = String(data: data, encoding: .utf8) else { return }
    socket?.send(.string(message)) { error in
      if let error {
        NSLog("Blueant live voice: audio turn commit failed: %@", error.localizedDescription)
      }
    }
  }

  private func receive() {
    socket?.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        let text: String?
        switch message {
        case .string(let value):
          text = value
        case .data(let data):
          text = String(data: data, encoding: .utf8)
        @unknown default:
          text = nil
        }
        // URLSession delivers WebSocket callbacks off the main thread.
        // `handle` invokes AppKit-facing callbacks and schedules audio nodes,
        // so serialize the whole message handler on the main queue.
        if let text {
          DispatchQueue.main.async { [weak self] in self?.handle(text) }
        }
        if self.isRunning { self.receive() }
      case .failure(let error):
        if self.isRunning {
          NSLog("Blueant live voice: bridge socket failed: %@", error.localizedDescription)
          DispatchQueue.main.async { [weak self] in
            guard let self, self.isRunning else { return }
            self.callbacks.onFailure?(error.localizedDescription)
          }
        }
      }
    }
  }

  private func handle(_ text: String) {
    guard let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String else { return }
    switch type {
    case "connecting":
      callbacks.onConnecting?()
    case "ready":
      setupTimeout?.cancel()
      setupTimeout = nil
      NSLog("Blueant live voice: Gemini setup complete")
      callbacks.onReady?()
    case "text": callbacks.onText?(object["text"] as? String ?? "")
    case "transcript":
      callbacks.onTranscript?(object["role"] as? String ?? "", object["text"] as? String ?? "",
                              object["finished"] as? Bool ?? false)
    case "interrupted":
      NSLog("Blueant live voice: Gemini detected user speech; stopping current playback")
      responseStateLock.lock()
      responseBuffersQueued = 0
      bargeInFrames = 0
      lastResponseAudioPlayedAt = Date.distantPast
      responseStateLock.unlock()
      player.stop()
      player.reset()
      player.play()
      callbacks.onInterrupted?()
    case "turnComplete": callbacks.onTurnComplete?()
    case "audio":
      guard let encoded = object["data"] as? String, let pcm = Data(base64Encoded: encoded) else { return }
      NSLog("Blueant live voice: received %d bytes of response audio", pcm.count)
      play(pcm)
    case "error":
      let message = object["message"] as? String ?? "Live voice failed"
      NSLog("Blueant live voice: provider error: %@", message)
      callbacks.onFailure?(message)
    case "closed":
      let message = "Gemini Live connection closed"
      NSLog("Blueant live voice: %@", message)
      callbacks.onFailure?(message)
    case "toolCall":
      let id = object["id"] as? String ?? ""
      let name = object["name"] as? String ?? ""
      let args = object["args"] as? [String: Any] ?? [:]
      NSLog("Blueant live voice: provider requested tool %@", name)
      callbacks.onToolCall?(id, name, args)
    default: break
    }
  }

  private func play(_ data: Data) {
    guard data.count >= 2,
          let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: 24_000, channels: 1, interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                          frameCapacity: AVAudioFrameCount(data.count / 2)),
          let destination = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(data.count / 2)
    data.withUnsafeBytes { source in
      for index in 0..<Int(buffer.frameLength) {
        let offset = index * MemoryLayout<Int16>.size
        let low = UInt16(source[offset])
        let high = UInt16(source[offset + 1]) << 8
        let sample = Int16(bitPattern: low | high)
        destination[index] = Float(sample) / 32768
      }
    }
    responseStateLock.lock()
    responseBuffersQueued += 1
    lastResponseAudioPlayedAt = Date()
    responseStateLock.unlock()
    player.scheduleBuffer(buffer) { [weak self] in
      guard let self else { return }
      self.responseStateLock.lock()
      self.responseBuffersQueued = max(0, self.responseBuffersQueued - 1)
      self.lastResponseAudioPlayedAt = Date()
      self.responseStateLock.unlock()
    }
    if !player.isPlaying { player.play() }
  }
}

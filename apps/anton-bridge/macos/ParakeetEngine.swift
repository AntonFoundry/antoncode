import Foundation

/// Parakeet TDT transcription engine (whisper.cpp's native Parakeet support,
/// vendored v1.9.4): single-pass transducer — no autoregressive 30 s window
/// loop — so partials over the growing dictation buffer return faster than
/// whisper small on short clips, output is punctuated/cased, and silence does
/// not hallucinate. English-focused (v3: 25 European languages); the engine
/// mirrors WhisperEngine's contract exactly, so SpeechController picks it
/// purely on model-file presence and falls back to whisper otherwise.
final class ParakeetEngine {
  private var context: OpaquePointer?
  private let transcriptionQueue = DispatchQueue(label: "dev.antoncode.blueant.parakeet", qos: .userInitiated)
  private let stateLock = NSLock()
  private var generation = 0
  private(set) var available = false

  /// Search roots for GGUF model files, in resolution order; the parakeet
  /// dir sits beside the whisper models so users drop one file to opt in.
  private static let modelSearchDirs: [String] = [
    "~/Library/Application Support/Anton/blueant/models/parakeet".expandingTilde,
  ]

  /// First *.gguf (or *.bin) file in the search dirs.
  static func resolveModelPath() -> String? {
    let fileManager = FileManager.default
    for dir in modelSearchDirs {
      guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { continue }
      let models = entries.filter { $0.hasSuffix(".gguf") || $0.hasSuffix(".bin") }.sorted()
      guard let name = models.first else { continue }
      return (dir as NSString).appendingPathComponent(name)
    }
    return nil
  }

  init() {
    guard let path = Self.resolveModelPath() else {
      NSLog("Blueant parakeet: no model file found in search dirs")
      return
    }
    var params = parakeet_context_default_params()
    params.use_gpu = true
    guard let context = parakeet_init_from_file_with_params(path, params) else {
      NSLog("Blueant parakeet: context init failed for %@", path)
      return
    }
    self.context = context
    available = true
    NSLog("Blueant parakeet model: %@", path)
  }

  deinit {
    if let context { parakeet_free(context) }
  }

  /// Cancels every pending and future transcription emission (abort path).
  func cancelAll() {
    stateLock.lock()
    generation += 1
    stateLock.unlock()
  }

  /// Transcribes a 16 kHz mono Float32 buffer on the serial queue and calls
  /// `completion(text)` on the main queue, unless cancelled meanwhile.
  func transcribe(_ samples: [Float], completion: @escaping (String) -> Void) {
    guard let context else { return }
    stateLock.lock()
    generation += 1
    let jobGeneration = generation
    stateLock.unlock()
    transcriptionQueue.async { [weak self] in
      guard let self else { return }
      var params = parakeet_full_default_params(PARAKEET_SAMPLING_GREEDY)
      params.no_context = true
      var text = ""
      if samples.withContiguousStorageIfAvailable({ storage in
        parakeet_full(context, params, UnsafeMutablePointer(mutating: storage.baseAddress), Int32(samples.count))
      }) == 0 {
        let segmentCount = parakeet_full_n_segments(context)
        for index in 0..<segmentCount {
          if let segment = parakeet_full_get_segment_text(context, index) {
            text += String(cString: segment)
          }
        }
      }
      let cancelled = {
        self.stateLock.lock()
        defer { self.stateLock.unlock() }
        return self.generation != jobGeneration
      }()
      guard !cancelled else { return }
      DispatchQueue.main.async { completion(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
  }
}

private extension String {
  var expandingTilde: String { (self as NSString).expandingTildeInPath }
}

import AVFoundation
import Foundation

/// whisper.cpp (Metal) transcription engine for Blueant push-to-talk.
/// Transcribes accumulated 16 kHz mono Float32 buffers on a serial queue;
/// `whisper.cpp` transcribes whole buffers, so the caller drives incremental
/// partials by re-submitting the growing buffer and replaces the previous
/// partial with each result. A generation counter cancels stale jobs: any
/// queued completion whose generation no longer matches is dropped, so
/// `cancelAll()` immediately silences pending and future emissions.
final class WhisperEngine {
  private var context: OpaquePointer?
  private let transcriptionQueue = DispatchQueue(label: "dev.antoncode.blueant.whisper", qos: .userInitiated)
  /// Guards `context` and `generation`; transcription runs synchronously on
  /// `transcriptionQueue` while state changes take the lock on the caller's
  /// thread. Serial queue + short critical sections keep `whisper_full` safe.
  private let stateLock = NSLock()
  private var generation = 0
  private(set) var available = false

  /// Search roots for GGML model files, in resolution order. Blueant's own
  /// Application Support directory is user-swappable; the Vox checkout path is
  /// the machine-local fallback that ships the model on this machine.
  private static let modelSearchDirs: [String] = [
    "~/Library/Application Support/Anton/blueant/models/whisper".expandingTilde,
    "/Users/pankajdoharey/Development/Projects/ML/Vox/voxkit/.models/whisper",
  ]

  /// Resolves the model path: first search dir containing a .bin file,
  /// preferring `ggml-small.bin`, then the alphabetically first *.bin.
  static func resolveModelPath() -> String? {
    let fileManager = FileManager.default
    for dir in modelSearchDirs {
      guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { continue }
      let models = entries.filter { $0.hasSuffix(".bin") }.sorted()
      guard !models.isEmpty else { continue }
      let name = models.first { $0 == "ggml-small.bin" } ?? models[0]
      return (dir as NSString).appendingPathComponent(name)
    }
    return nil
  }

  /// Loads the model and initializes the whisper context (Metal is embedded in
  /// the vendored static libs, so no runtime .metallib lookup is needed).
  init() {
    guard let path = Self.resolveModelPath() else {
      NSLog("Blueant whisper: no model file found in search dirs")
      return
    }
    var params = whisper_context_default_params()
    params.use_gpu = true
    guard let context = whisper_init_from_file_with_params(path, params) else {
      NSLog("Blueant whisper: context init failed for %@", path)
      return
    }
    self.context = context
    available = true
    NSLog("Blueant whisper model: %@", path)
  }

  deinit {
    if let context { whisper_free(context) }
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
      var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
      params.print_progress = false
      params.print_realtime = false
      params.print_special = false
      params.print_timestamps = false
      params.no_context = true
      params.language = UnsafePointer(strdup("auto"))
      var text = ""
      if samples.withContiguousStorageIfAvailable({ storage in
        whisper_full(context, params, UnsafeMutablePointer(mutating: storage.baseAddress), Int32(samples.count))
      }) == 0 {
        let segmentCount = whisper_full_n_segments(context)
        for index in 0..<segmentCount {
          if let segment = whisper_full_get_segment_text(context, index) {
            text += String(cString: segment)
          }
        }
      }
      free(UnsafeMutableRawPointer(mutating: params.language))
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

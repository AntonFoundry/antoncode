import Foundation

/// One selectable local model for Blueant's wake and voice transcription. The id is the
/// persisted engine + filename pair; paths are resolved locally and never
/// persisted, so moving the model directory does not corrupt settings.
struct LocalSpeechModel {
  enum Engine: String {
    case whisper
    case parakeet
  }

  let engine: Engine
  let fileName: String
  let path: String
  let byteCount: Int64

  var id: String { "\(engine.rawValue):\(fileName)" }

  var selection: [String: String] {
    ["engine": engine.rawValue, "file": fileName]
  }

  var displayName: String {
    "\(Self.modelName(engine: engine, fileName: fileName)) — \(Self.sizeFormatter.string(fromByteCount: byteCount))"
  }

  private static let sizeFormatter: ByteCountFormatter = {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    formatter.allowedUnits = [.useMB, .useGB]
    formatter.includesUnit = true
    formatter.isAdaptive = true
    return formatter
  }()

  private static func modelName(engine: Engine, fileName: String) -> String {
    if engine == .parakeet {
      if fileName.contains("0.6b-v3-q8") { return "Parakeet TDT 0.6B Q8" }
      return "Parakeet \(clean(fileName))"
    }
    let known: [String: String] = [
      "ggml-tiny-v2.bin": "Whisper Tiny v2",
      "ggml-base.bin": "Whisper Base",
      "ggml-small.bin": "Whisper Small",
      "ggml-medium.bin": "Whisper Medium",
      "ggml-large-v3-turbo.bin": "Whisper Large v3 Turbo",
      "ggml-large-v2.bin": "Whisper Large v2",
    ]
    return known[fileName] ?? "Whisper \(clean(fileName))"
  }

  private static func clean(_ fileName: String) -> String {
    fileName
      .replacingOccurrences(of: "ggml-", with: "")
      .replacingOccurrences(of: ".bin", with: "")
      .replacingOccurrences(of: ".gguf", with: "")
      .replacingOccurrences(of: "-", with: " ")
  }
}

/// Discovers the local speech catalog from model files. Anton's own model
/// directory wins over the machine-local Vox fallback when both contain the
/// same filename; duplicates and the ambiguous `default.bin` alias never
/// appear in the UI.
enum LocalSpeechModelCatalog {
  static let defaultSelection = (engine: "whisper", file: "ggml-small.bin")

  private static let whisperDirectories = [
    "~/Library/Application Support/Anton/blueant/models/whisper".expandingTilde,
    "/Users/pankajdoharey/Development/Projects/ML/Vox/voxlogic/.models/whisper",
  ]
  private static let parakeetDirectories = [
    "~/Library/Application Support/Anton/blueant/models/parakeet".expandingTilde,
  ]
  private static let whisperOrder = [
    "ggml-tiny-v2.bin",
    "ggml-base.bin",
    "ggml-small.bin",
    "ggml-medium.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-large-v2.bin",
  ]

  static func available() -> [LocalSpeechModel] {
    var seen = Set<String>()
    var models: [LocalSpeechModel] = []
    append(engine: .whisper, directories: whisperDirectories, seen: &seen, models: &models)
    append(engine: .parakeet, directories: parakeetDirectories, seen: &seen, models: &models)
    return models.sorted { lhs, rhs in
      if lhs.engine != rhs.engine { return lhs.engine == .whisper }
      if lhs.engine == .whisper {
        let left = whisperOrder.firstIndex(of: lhs.fileName) ?? Int.max
        let right = whisperOrder.firstIndex(of: rhs.fileName) ?? Int.max
        if left != right { return left < right }
      }
      return lhs.fileName.localizedStandardCompare(rhs.fileName) == .orderedAscending
    }
  }

  static func resolve(engine: String?, file: String?) -> LocalSpeechModel? {
    let available = available()
    if let engine, let file,
       let exact = available.first(where: { $0.engine.rawValue == engine && $0.fileName == file }) {
      return exact
    }
    if engine != nil || file != nil {
      NSLog("Blueant wake model %@:%@ is unavailable; using the default", engine ?? "?", file ?? "?")
    }
    return available.first(where: {
      $0.engine.rawValue == defaultSelection.engine && $0.fileName == defaultSelection.file
    }) ?? available.first
  }

  private static func append(engine: LocalSpeechModel.Engine, directories: [String],
                             seen: inout Set<String>, models: inout [LocalSpeechModel]) {
    let fileManager = FileManager.default
    for directory in directories {
      guard let entries = try? fileManager.contentsOfDirectory(atPath: directory) else { continue }
      for fileName in entries.sorted() {
        guard fileName != "default.bin",
              fileName.hasSuffix(".bin") || fileName.hasSuffix(".gguf") else { continue }
        let id = "\(engine.rawValue):\(fileName)"
        guard seen.insert(id).inserted else { continue }
        let path = (directory as NSString).appendingPathComponent(fileName)
        guard let attributes = try? fileManager.attributesOfItem(atPath: path),
              let size = attributes[.size] as? NSNumber else { continue }
        models.append(LocalSpeechModel(engine: engine, fileName: fileName,
                                       path: path, byteCount: size.int64Value))
      }
    }
  }
}

private extension String {
  var expandingTilde: String { (self as NSString).expandingTildeInPath }
}

import Foundation

/// One serial queue for every local ggml transcription, shared by whisper and
/// parakeet. Each engine builds its own Metal context, and running two native
/// decodes at once is what the "aborts the host process" reports came from:
/// the wake listener, push-to-talk dictation, and the live session's local
/// transcript can all request a decode, so serializing them here makes that
/// overlap impossible no matter which engine the user selects.
enum LocalSpeechQueue {
  static let shared = DispatchQueue(label: "dev.antoncode.blueant.local-speech", qos: .userInitiated)
}

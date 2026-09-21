// A/B latency harness: whisper small (Metal) vs parakeet TDT (Metal) on the
// same utterance, N passes each, median wall time + transcript.
// Build: see ab.sh beside this file.
import AVFoundation
import Foundation

let wavPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "test.wav"
let passes = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2])! : 3

guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: wavPath)) else {
  print("cannot read \(wavPath)"); exit(1)
}
let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
      (try? file.read(into: buffer)) != nil else { print("read failed"); exit(1) }
guard let converter = AVAudioConverter(from: file.processingFormat, to: format),
      let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / file.processingFormat.sampleRate + 32)) else {
  print("convert setup failed"); exit(1)
}
var conversionError: NSError?
var fed = false
converter.convert(to: converted, error: &conversionError) { _, status in
  if fed { status.pointee = .noDataNow; return nil }
  fed = true; status.pointee = .haveData; return buffer
}
guard conversionError == nil, let channel = converted.floatChannelData?[0] else { print("convert failed"); exit(1) }
var samples = [Float](UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
// Parakeet TDT chunks internally at ~2 s without silence padding; whisper
// wants ≥ 1 s of audio to engage its windowing. Pad to a round 4 s so both
// engines see identical input length.
if samples.count < 64_000 { samples += [Float](repeating: 0, count: 64_000 - samples.count) }
print(String(format: "samples: %.2f s", Double(samples.count) / 16_000))

func bench(_ name: String, model: String, useParakeet: Bool) {
  let t0 = DispatchTime.now()
  var text = ""
  if useParakeet {
    var cparams = parakeet_context_default_params()
    cparams.use_gpu = true
    guard let ctx = parakeet_init_from_file_with_params(model, cparams) else { print("\(name): init failed"); exit(1) }
    let loadTime = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e9
    var times: [Double] = []
    for pass in 0..<passes {
      let p0 = DispatchTime.now()
      var params = parakeet_full_default_params(PARAKEET_SAMPLING_GREEDY)
      params.no_context = true
      _ = samples.withContiguousStorageIfAvailable { storage in
        parakeet_full(ctx, params, UnsafeMutablePointer(mutating: storage.baseAddress), Int32(samples.count))
      }
      times.append(Double(DispatchTime.now().uptimeNanoseconds - p0.uptimeNanoseconds) / 1e9)
      if pass == 0 {
        for i in 0..<parakeet_full_n_segments(ctx) {
          if let seg = parakeet_full_get_segment_text(ctx, i) { text += String(cString: seg) }
        }
      }
    }
    parakeet_free(ctx)
    report(name, loadTime: loadTime, times: times, text: text)
  } else {
    var cparams = whisper_context_default_params()
    cparams.use_gpu = true
    guard let ctx = whisper_init_from_file_with_params(model, cparams) else { print("\(name): init failed"); exit(1) }
    let loadTime = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e9
    var times: [Double] = []
    for pass in 0..<passes {
      let p0 = DispatchTime.now()
      var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
      params.print_progress = false; params.print_realtime = false
      params.print_special = false; params.print_timestamps = false
      params.no_context = true
      params.language = UnsafePointer(strdup("en"))
      _ = samples.withContiguousStorageIfAvailable { storage in
        whisper_full(ctx, params, UnsafeMutablePointer(mutating: storage.baseAddress), Int32(samples.count))
      }
      free(UnsafeMutableRawPointer(mutating: params.language))
      times.append(Double(DispatchTime.now().uptimeNanoseconds - p0.uptimeNanoseconds) / 1e9)
      if pass == 0 {
        for i in 0..<whisper_full_n_segments(ctx) {
          if let seg = whisper_full_get_segment_text(ctx, i) { text += String(cString: seg) }
        }
      }
    }
    whisper_free(ctx)
    report(name, loadTime: loadTime, times: times, text: text)
  }
}

func report(_ name: String, loadTime: Double, times: [Double], text: String) {
  let sorted = times.sorted()
  let median = sorted[times.count / 2]
  print(String(format: "%@: load %.2fs | decode median %.0fms min %.0fms | %@", name, loadTime, median * 1000, (sorted.first ?? 0) * 1000, text.trimmingCharacters(in: .whitespacesAndNewlines)))
}

let home = FileManager.default.homeDirectoryForCurrentUser.path
bench("whisper-small", model: home + "/Development/Projects/ML/Vox/voxkit/.models/whisper/ggml-small.bin", useParakeet: false)
bench("parakeet-v3-q8", model: home + "/Library/Application Support/Anton/blueant/models/parakeet/ggml-parakeet-tdt-0.6b-v3-q8_0.bin", useParakeet: true)

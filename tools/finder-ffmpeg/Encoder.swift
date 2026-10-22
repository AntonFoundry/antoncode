import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class Encoder: ObservableObject {
  let input: URL
  @Published var format = "mp4"
  @Published var video = "H.264"
  @Published var quality = "23"
  @Published var audio = "AAC"
  @Published var bitrate = "192k"
  @Published var destination: String
  @Published var message = "Ready"
  @Published var running = false
  private var process: Process?
  private var output: URL?
  private var cancelled = false

  init(input: URL) {
    self.input = input
    destination = input.deletingPathExtension().path + "-encoded.mp4"
  }

  func setFormat(_ value: String) {
    destination = URL(fileURLWithPath: destination).deletingPathExtension().path + "." + value
    format = value
    if value == "webm" {
      video = "VP9"
      audio = "Opus"
    } else {
      video = "H.264"
      audio = "AAC"
    }
  }

  func encode() {
    let target = URL(fileURLWithPath: destination)
    guard target.pathExtension.lowercased() == format,
          target.standardizedFileURL != input.standardizedFileURL,
          !FileManager.default.fileExists(atPath: target.path) else {
      message = "Choose a new .\(format) filename; existing files are never replaced."
      return
    }
    let codecs = ["H.264": "libx264", "H.265": "libx265", "VP9": "libvpx-vp9", "AV1": "libaom-av1"]
    guard let codec = codecs[video] else { return }
    guard (format == "webm" && ["VP9", "AV1"].contains(video) && audio != "AAC") ||
          (format != "webm" && !["VP9", "Opus"].contains(video) && audio != "Opus") else {
      message = "That video/audio combination is not supported in \(format.uppercased())."
      return
    }
    guard let ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].first(where: FileManager.default.isExecutableFile(atPath:)) else {
      message = "FFmpeg not found. Install it with brew install ffmpeg."
      return
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: ffmpeg)
    task.arguments = ["-nostdin", "-n", "-i", input.path, "-map", "0:v:0", "-c:v", codec, "-crf", quality]
      + (["VP9", "AV1"].contains(video) ? ["-b:v", "0"] : ["-preset", "medium"])
      + (audio == "None" ? ["-an"] : ["-map", "0:a?", "-c:a", audio == "Opus" ? "libopus" : "aac", "-b:a", bitrate])
      + [target.path]
    task.standardInput = FileHandle.nullDevice
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    task.terminationHandler = { [weak self] completed in
      DispatchQueue.main.async { self?.finish(completed.terminationStatus == 0) }
    }
    do {
      try task.run()
      output = target
      process = task
      cancelled = false
      running = true
      message = "Encoding…"
    } catch {
      message = "Could not start FFmpeg: \(error.localizedDescription)"
    }
  }

  private func finish(_ success: Bool) {
    running = false
    process = nil
    if !success, let output { try? FileManager.default.removeItem(at: output) }
    message = success ? "Saved \(output?.lastPathComponent ?? "video")" : (cancelled ? "Cancelled" : "Encoding failed; check the input and installed codecs.")
  }

  func cancel() {
    guard let process, running else { return }
    cancelled = true
    process.terminate()
  }
}

struct EncoderView: View {
  @ObservedObject var encoder: Encoder

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(encoder.input.lastPathComponent).font(.headline).lineLimit(1)
      Form {
        Picker("Output format", selection: Binding(get: { encoder.format }, set: { encoder.setFormat($0) })) {
          ForEach(["mp4", "mov", "mkv", "webm"], id: \.self) { Text($0.uppercased()) }
        }
        Picker("Video codec", selection: $encoder.video) {
          ForEach(["H.264", "H.265", "VP9", "AV1"], id: \.self) { Text($0) }
        }
        Picker("Quality (CRF)", selection: $encoder.quality) {
          Text("High · 18").tag("18")
          Text("Balanced · 23").tag("23")
          Text("Small · 28").tag("28")
        }
        Picker("Audio codec", selection: $encoder.audio) {
          ForEach(["AAC", "Opus", "None"], id: \.self) { Text($0) }
        }
        Picker("Audio bitrate", selection: $encoder.bitrate) {
          ForEach(["128k", "192k", "256k"], id: \.self) { Text($0) }
        }.disabled(encoder.audio == "None")
        TextField("Save as", text: $encoder.destination)
      }.disabled(encoder.running)
      HStack {
        if encoder.running { ProgressView().controlSize(.small) }
        Text(encoder.message).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
        Button(encoder.running ? "Cancel" : "Close") {
          if encoder.running { encoder.cancel() } else { NSApp.terminate(nil) }
        }
        Button("Encode") { encoder.encode() }.disabled(encoder.running)
      }
    }.padding(22).frame(width: 520)
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow?
  private var encoder: Encoder?

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard CommandLine.arguments.count == 2 else { NSApp.terminate(nil); return }
    let input = URL(fileURLWithPath: CommandLine.arguments[1])
    guard (try? input.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey]).isRegularFile) == true,
          (try? input.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .movie)) == true else {
      let alert = NSAlert()
      alert.messageText = "Select one local video file in Finder."
      alert.runModal()
      NSApp.terminate(nil)
      return
    }
    let model = Encoder(input: input)
    encoder = model
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 350), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Encode with FFmpeg"
    window.contentView = NSHostingView(rootView: EncoderView(encoder: model))
    window.delegate = self
    window.center()
    window.makeKeyAndOrderFront(nil)
    self.window = window
    NSApp.activate(ignoringOtherApps: true)
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if encoder?.running == true { encoder?.cancel(); return false }
    NSApp.terminate(nil)
    return true
  }
}

@main
struct Main {
  @MainActor static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
  }
}

import Cocoa
import CryptoKit

/// Native-only presentation of a Host-issued action challenge. The seed is
/// carried from Anton through private stdin pipes, never an HTTP response.
struct NativeConsentChallenge {
  let requestId: String
  let binding: String
  let expiresAt: Int64
  let summary: String
}

extension NativeConsentChallenge: Decodable {}

enum NativeConsentCode {
  private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

  static func mac(seed: Data, fields: [String]) -> String? {
    guard seed.count == 32 else { return nil }
    var input = Data()
    for field in fields {
      let bytes = Data(field.utf8)
      guard bytes.count <= Int(UInt32.max) else { return nil }
      var length = UInt32(bytes.count).bigEndian
      withUnsafeBytes(of: &length) { input.append(contentsOf: $0) }
      input.append(bytes)
    }
    let digest = HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: seed))
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Mirrors native-consent-code.ts: HMAC-SHA256 over four UTF-8 fields,
  /// each prefixed by a 32-bit big-endian byte length, truncated to 40 bits.
  static func derive(seed: Data, challenge: NativeConsentChallenge) -> String? {
    guard seed.count == 32 else { return nil }
    var input = Data()
    for field in ["antonmail-code-v1", challenge.requestId, challenge.binding, String(challenge.expiresAt)] {
      let bytes = Data(field.utf8)
      guard bytes.count <= Int(UInt32.max) else { return nil }
      var length = UInt32(bytes.count).bigEndian
      withUnsafeBytes(of: &length) { input.append(contentsOf: $0) }
      input.append(bytes)
    }
    let mac = HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: seed))
    let bytes = Array(mac.prefix(5))
    var bits: UInt64 = 0
    for byte in bytes { bits = (bits << 8) | UInt64(byte) }
    return String((0..<8).reversed().map { index in alphabet[Int((bits >> (index * 5)) & 31)] })
  }
}

/// This panel never accepts a decision. The user must type the code in the
/// Anton Agent Mail view after checking the action summary shown here.
final class NativeConsentPanel: NSPanel {
  init(challenge: NativeConsentChallenge, code: String) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 430, height: 220),
               styleMask: [.titled, .closable], backing: .buffered, defer: false)
    title = "Anton Agent Mail authorization"
    level = .floating
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.spacing = 12
    stack.alignment = .leading
    stack.translatesAutoresizingMaskIntoConstraints = false
    let summary = NSTextField(wrappingLabelWithString: challenge.summary)
    summary.maximumNumberOfLines = 3
    let codeLabel = NSTextField(labelWithString: code)
    codeLabel.font = .monospacedSystemFont(ofSize: 28, weight: .bold)
    let warning = NSTextField(wrappingLabelWithString: "Only enter this code in Anton for the action above. It expires shortly; closing this window does not authorize anything.")
    warning.maximumNumberOfLines = 3
    stack.addArrangedSubview(summary)
    stack.addArrangedSubview(codeLabel)
    stack.addArrangedSubview(warning)
    contentView?.addSubview(stack)
    if let contentView {
      NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
        stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
        stack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      ])
    }
    center()
  }
}

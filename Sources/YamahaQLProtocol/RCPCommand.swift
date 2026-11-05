import Foundation

/// Commands sent to the console. Each command is one line terminated by `\n`.
public enum RCPCommand: Hashable, Sendable {
    case get(address: String, x: Int, y: Int)
    case set(address: String, x: Int, y: Int, value: RCPValue)
    /// `devinfo productname`, `devinfo version`, …
    case devinfo(String)
    /// `devstatus runmode`, …
    case devstatus(String)
    /// `ssrecall_ex MIXER:Lib/Scene <n>`
    case sceneRecall(number: Int)
    /// `sscurrent_ex MIXER:Lib/Scene`
    case sceneCurrent
    /// `mtrstart <address> <interval ms>`
    case meterStart(address: String, intervalMs: Int)
    /// `mtrstop <address>`
    case meterStop(address: String)
    /// Free text, sent verbatim (used by the protocol console in the log window).
    case raw(String)

    public static let sceneBank = "MIXER:Lib/Scene"

    /// Line without trailing newline.
    public var line: String {
        switch self {
        case let .get(address, x, y):
            "get \(address) \(x) \(y)"
        case let .set(address, x, y, value):
            "set \(address) \(x) \(y) \(value.encoded)"
        case let .devinfo(item):
            "devinfo \(item)"
        case let .devstatus(item):
            "devstatus \(item)"
        case let .sceneRecall(number):
            "ssrecall_ex \(Self.sceneBank) \(number)"
        case .sceneCurrent:
            "sscurrent_ex \(Self.sceneBank)"
        case let .meterStart(address, interval):
            "mtrstart \(address) \(interval)"
        case let .meterStop(address):
            "mtrstop \(address)"
        case let .raw(text):
            text.trimmingCharacters(in: .newlines)
        }
    }

    /// Bytes on the wire (UTF-8, LF terminated).
    public var wireData: [UInt8] { Array((line + "\n").utf8) }
}

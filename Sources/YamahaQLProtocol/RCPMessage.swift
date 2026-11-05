/// A parameter value as transported by RCP: either an integer or a string.
public enum RCPValue: Hashable, Sendable, CustomStringConvertible {
    case int(Int)
    case string(String)

    public var intValue: Int? {
        if case .int(let v) = self { v } else { nil }
    }

    public var stringValue: String? {
        if case .string(let v) = self { v } else { nil }
    }

    /// Wire representation (strings are quoted).
    public var encoded: String {
        switch self {
        case .int(let v): String(v)
        case .string(let s): RCPTokenizer.quote(s)
        }
    }

    public var description: String { encoded }
}

/// Status word that prefixes every line the console sends.
public enum RCPStatus: String, Sendable {
    case ok = "OK"
    case okm = "OKm"
    case notify = "NOTIFY"
    case error = "ERROR"

    init?(token: String) {
        switch token.uppercased() {
        case "OK": self = .ok
        case "OKM": self = .okm
        case "NOTIFY": self = .notify
        case "ERROR": self = .error
        default: return nil
        }
    }
}

/// A single parameter value reported by the console (`OK get`, `OK set`, `NOTIFY set`).
public struct ParameterReport: Hashable, Sendable {
    public var address: String
    public var x: Int
    public var y: Int
    public var value: RCPValue
    /// Human readable value the console sometimes appends (e.g. `"-10.00"`).
    public var display: String?

    public init(address: String, x: Int, y: Int, value: RCPValue, display: String? = nil) {
        self.address = address
        self.x = x
        self.y = y
        self.value = value
        self.display = display
    }
}

/// A decoded line received from the console.
public enum RCPMessage: Hashable, Sendable {
    /// `OK get …`, `OK set …`, `NOTIFY set …`
    case parameter(status: RCPStatus, command: String, ParameterReport)
    /// `NOTIFY mtr <address> <name> hh hh hh …` – raw meter values (0…127, dB = raw − 126).
    case meter(address: String, values: [Int])
    /// Scene related messages: `OK ssrecall_ex MIXER:Lib/Scene 5`, `NOTIFY sscurrent_ex MIXER:Lib/Scene 5`
    case scene(status: RCPStatus, command: String, bank: String, number: Int)
    /// Device info & misc answers: `OK devinfo productname "QL5"`, `OK devstatus runmode "normal"`
    case info(status: RCPStatus, command: String, arguments: [String])
    /// `ERROR <command> <reason…>`
    case error(command: String, reason: String)
    /// Anything we could not classify.
    case unknown(String)

    // MARK: Parsing

    public static func parse<S: StringProtocol>(_ line: S) -> RCPMessage {
        let tokens = RCPTokenizer.tokenize(line)
        let raw = String(line)
        guard tokens.count >= 2, let status = RCPStatus(token: tokens[0].text) else {
            return .unknown(raw)
        }
        let command = tokens[1].text

        if status == .error {
            let reason = tokens.dropFirst(2).map(\.text).joined(separator: " ")
            return .error(command: command, reason: reason)
        }

        switch command {
        case "get", "set":
            guard tokens.count >= 6,
                  let x = Int(tokens[3].text),
                  let y = Int(tokens[4].text)
            else {
                // e.g. "OK set" acknowledgements without payload
                return .info(status: status, command: command, arguments: tokens.dropFirst(2).map(\.text))
            }
            let valueToken = tokens[5]
            let value: RCPValue
            if !valueToken.isQuoted, let int = Int(valueToken.text) {
                value = .int(int)
            } else {
                value = .string(valueToken.text)
            }
            let display = tokens.count >= 7 ? tokens[6].text : nil
            return .parameter(
                status: status,
                command: command,
                ParameterReport(address: tokens[2].text, x: x, y: y, value: value, display: display)
            )

        case "mtr":
            guard tokens.count >= 3 else { return .unknown(raw) }
            return .meter(address: tokens[2].text, values: decodeMeterValues(tokens.dropFirst(3)))

        default:
            if command.hasPrefix("ss"), tokens.count >= 4, let number = Int(tokens[3].text) {
                return .scene(status: status, command: command, bank: tokens[2].text, number: number)
            }
            return .info(status: status, command: command, arguments: tokens.dropFirst(2).map(\.text))
        }
    }

    /// Meter payloads are a list of hexadecimal bytes. The first token may be a
    /// non-hex name (e.g. the pickoff point) which is skipped. A single long hex
    /// token (`"7e7e00…"`) is split into byte pairs.
    static func decodeMeterValues(_ tokens: ArraySlice<RCPToken>) -> [Int] {
        var values: [Int] = []
        for token in tokens {
            let text = token.text
            guard !text.isEmpty, text.allSatisfy(\.isHexDigit) else { continue }
            if text.count <= 2 {
                if let v = Int(text, radix: 16) { values.append(v) }
            } else if text.count % 2 == 0 {
                var index = text.startIndex
                while index < text.endIndex {
                    let next = text.index(index, offsetBy: 2)
                    if let v = Int(text[index..<next], radix: 16) { values.append(v) }
                    index = next
                }
            }
        }
        return values
    }
}

/// Tokenizer for the Yamaha RCP text protocol.
///
/// Lines are space separated. String values are wrapped in double quotes and may
/// contain spaces as well as backslash escapes (`\"`, `\\`).
public enum RCPToken: Equatable, Sendable {
    case word(String)
    case quoted(String)

    public var text: String {
        switch self {
        case .word(let s), .quoted(let s): s
        }
    }

    public var isQuoted: Bool {
        if case .quoted = self { true } else { false }
    }
}

public enum RCPTokenizer {
    public static func tokenize<S: StringProtocol>(_ line: S) -> [RCPToken] {
        var tokens: [RCPToken] = []
        var current = ""
        var inQuotes = false
        var hasToken = false
        var escaping = false

        for ch in line {
            if inQuotes {
                if escaping {
                    current.append(ch)
                    escaping = false
                } else if ch == "\\" {
                    escaping = true
                } else if ch == "\"" {
                    tokens.append(.quoted(current))
                    current = ""
                    inQuotes = false
                    hasToken = false
                } else {
                    current.append(ch)
                }
            } else if ch == "\"" {
                if hasToken {
                    tokens.append(.word(current))
                    current = ""
                }
                inQuotes = true
                hasToken = false
            } else if ch == " " || ch == "\t" || ch == "\r" || ch == "\n" {
                if hasToken {
                    tokens.append(.word(current))
                    current = ""
                    hasToken = false
                }
            } else {
                current.append(ch)
                hasToken = true
            }
        }
        if inQuotes {
            // Unterminated string – be lenient and keep what we have.
            tokens.append(.quoted(current))
        } else if hasToken {
            tokens.append(.word(current))
        }
        return tokens
    }

    /// Quotes a string value for sending.
    public static func quote(_ value: String) -> String {
        var out = "\""
        for ch in value {
            if ch == "\"" || ch == "\\" { out.append("\\") }
            out.append(ch)
        }
        out.append("\"")
        return out
    }
}

/// Channel types of a CL/QL console as exposed via RCP.
///
/// Some logical strips map to several wire indices:
/// * Stereo inputs (`StInCh`) are addressed as 16 mono halves (L = 2n, R = 2n+1).
/// * `St` has three entries: 0 = ST L, 1 = ST R, 2 = MONO (C).
public enum ChannelKind: String, CaseIterable, Hashable, Sendable, Codable {
    case input
    case stereoInput
    case mix
    case matrix
    case stereo
    case mono
    case dca

    /// Address segment used in `MIXER:Current/<segment>/…`.
    public var addressSegment: String {
        switch self {
        case .input: "InCh"
        case .stereoInput: "StInCh"
        case .mix: "Mix"
        case .matrix: "Mtrx"
        case .stereo, .mono: "St"
        case .dca: "DCA"
        }
    }

    public var displayName: String {
        switch self {
        case .input: "Input"
        case .stereoInput: "ST IN"
        case .mix: "Mix"
        case .matrix: "Matrix"
        case .stereo: "Stereo"
        case .mono: "Mono"
        case .dca: "DCA"
        }
    }

    /// Short prefix used for strip numbering ("CH 1", "MX 3", …).
    public var shortPrefix: String {
        switch self {
        case .input: "CH"
        case .stereoInput: "ST IN"
        case .mix: "MIX"
        case .matrix: "MTX"
        case .stereo: "ST"
        case .mono: "MONO"
        case .dca: "DCA"
        }
    }

    /// Wire (x) indices controlled by one logical strip.
    public func wireIndices(for logical: Int) -> [Int] {
        switch self {
        case .stereoInput: [logical * 2, logical * 2 + 1]
        case .stereo: [0, 1]
        case .mono: [2]
        default: [logical]
        }
    }

    /// The wire index whose value is considered authoritative for the strip.
    public func primaryWireIndex(for logical: Int) -> Int { wireIndices(for: logical)[0] }

    /// Reverse mapping: only the primary wire index yields a logical index.
    public func logicalIndex(forPrimaryWireIndex x: Int) -> Int? {
        switch self {
        case .stereoInput: x % 2 == 0 ? x / 2 : nil
        case .stereo: x == 0 ? 0 : nil
        case .mono: x == 2 ? 0 : nil
        default: x
        }
    }

    static func kinds(forSegment segment: String) -> [ChannelKind] {
        switch segment {
        case "InCh": [.input]
        case "StInCh": [.stereoInput]
        case "Mix": [.mix]
        case "Mtrx": [.matrix]
        case "St": [.stereo, .mono]
        case "DCA": [.dca]
        default: []
        }
    }

    public var supportsCue: Bool { true }
    /// Only inputs can be routed to mixes in "sends on fader" mode.
    public var canSendToMix: Bool { self == .input || self == .stereoInput }
}

/// A logical channel strip.
public struct ChannelID: Hashable, Sendable, Codable, Comparable, CustomStringConvertible {
    public var kind: ChannelKind
    /// Zero-based logical index.
    public var index: Int

    public init(_ kind: ChannelKind, _ index: Int) {
        self.kind = kind
        self.index = index
    }

    public var number: Int { index + 1 }

    public var description: String {
        switch kind {
        case .stereo, .mono: kind.shortPrefix
        default: "\(kind.shortPrefix) \(number)"
        }
    }

    public static func < (lhs: ChannelID, rhs: ChannelID) -> Bool {
        let l = ChannelKind.allCases.firstIndex(of: lhs.kind)!
        let r = ChannelKind.allCases.firstIndex(of: rhs.kind)!
        return l == r ? lhs.index < rhs.index : l < r
    }
}

public enum ChannelParameter: String, CaseIterable, Hashable, Sendable {
    case level   // Fader/Level, Int (0.01 dB), -32768 = -∞
    case on      // Fader/On, 0/1  (the "ON" key – off == muted)
    case name    // Label/Name, String (max 8 chars)
    case color   // Label/Color, String
    case cue     // Cue/<seg>/On, 0/1
}

public enum SendParameter: String, CaseIterable, Hashable, Sendable {
    case level   // ToMix/Level
    case on      // ToMix/On
}

/// A parameter of the console in logical terms.
public enum ParameterKey: Hashable, Sendable {
    case channel(ChannelID, ChannelParameter)
    /// Send from an input strip to mix bus `mix` (zero-based).
    case send(ChannelID, mix: Int, SendParameter)

    public static let addressPrefix = "MIXER:Current/"

    public var address: String {
        switch self {
        case let .channel(id, param):
            let seg = id.kind.addressSegment
            return switch param {
            case .level: "\(Self.addressPrefix)\(seg)/Fader/Level"
            case .on: "\(Self.addressPrefix)\(seg)/Fader/On"
            case .name: "\(Self.addressPrefix)\(seg)/Label/Name"
            case .color: "\(Self.addressPrefix)\(seg)/Label/Color"
            case .cue: "\(Self.addressPrefix)Cue/\(seg)/On"
            }
        case let .send(id, _, param):
            let seg = id.kind.addressSegment
            return switch param {
            case .level: "\(Self.addressPrefix)\(seg)/ToMix/Level"
            case .on: "\(Self.addressPrefix)\(seg)/ToMix/On"
            }
        }
    }

    public var channel: ChannelID {
        switch self {
        case .channel(let id, _), .send(let id, _, _): id
        }
    }

    /// All wire (x, y) targets this logical parameter maps to.
    public var wireTargets: [(x: Int, y: Int)] {
        switch self {
        case let .channel(id, _):
            id.kind.wireIndices(for: id.index).map { ($0, 0) }
        case let .send(id, mix, _):
            id.kind.wireIndices(for: id.index).map { ($0, mix) }
        }
    }

    public var primaryTarget: (x: Int, y: Int) { wireTargets[0] }

    /// Decodes a wire address into logical keys. Returns `nil` for unknown
    /// addresses and for secondary halves of stereo pairs.
    public static func decode(address: String, x: Int, y: Int) -> ParameterKey? {
        guard address.hasPrefix(addressPrefix) else { return nil }
        let parts = address.dropFirst(addressPrefix.count).split(separator: "/").map(String.init)

        if parts.count == 3, parts[0] == "Cue", parts[2] == "On" {
            for kind in ChannelKind.kinds(forSegment: parts[1]) {
                if let i = kind.logicalIndex(forPrimaryWireIndex: x) {
                    return .channel(ChannelID(kind, i), .cue)
                }
            }
            return nil
        }
        guard parts.count == 3 else { return nil }
        let path = parts[1] + "/" + parts[2]

        for kind in ChannelKind.kinds(forSegment: parts[0]) {
            guard let i = kind.logicalIndex(forPrimaryWireIndex: x) else { continue }
            let id = ChannelID(kind, i)
            switch path {
            case "Fader/Level": return .channel(id, .level)
            case "Fader/On": return .channel(id, .on)
            case "Label/Name": return .channel(id, .name)
            case "Label/Color": return .channel(id, .color)
            case "ToMix/Level": return .send(id, mix: y, .level)
            case "ToMix/On": return .send(id, mix: y, .on)
            default: return nil
            }
        }
        return nil
    }
}

public extension RCPCommand {
    /// `get` for the primary wire target.
    static func get(_ key: ParameterKey) -> RCPCommand {
        let t = key.primaryTarget
        return .get(address: key.address, x: t.x, y: t.y)
    }

    /// `set` for every wire target (stereo pairs are written L and R).
    static func set(_ key: ParameterKey, _ value: RCPValue) -> [RCPCommand] {
        key.wireTargets.map { .set(address: key.address, x: $0.x, y: $0.y, value: value) }
    }
}

/// Channel layout of a console model.
public struct ConsoleModel: Hashable, Sendable {
    public var name: String
    public var counts: [ChannelKind: Int]

    public func count(_ kind: ChannelKind) -> Int { counts[kind] ?? 0 }

    public func channels(_ kind: ChannelKind) -> [ChannelID] {
        (0..<count(kind)).map { ChannelID(kind, $0) }
    }

    public var allChannels: [ChannelID] {
        ChannelKind.allCases.flatMap { channels($0) }
    }

    static func make(_ name: String, inputs: Int, mixes: Int) -> ConsoleModel {
        ConsoleModel(name: name, counts: [
            .input: inputs, .stereoInput: 8, .mix: mixes, .matrix: 8,
            .stereo: 1, .mono: 1, .dca: 16,
        ])
    }

    public static let ql5 = make("QL5", inputs: 64, mixes: 16)
    public static let ql1 = make("QL1", inputs: 32, mixes: 16)
    public static let cl5 = make("CL5", inputs: 72, mixes: 24)
    public static let cl3 = make("CL3", inputs: 64, mixes: 24)
    public static let cl1 = make("CL1", inputs: 48, mixes: 24)
    public static let all: [ConsoleModel] = [.ql5, .ql1, .cl5, .cl3, .cl1]

    /// Maps the answer of `devinfo productname` to a model (defaults to QL5).
    public static func from(productName: String) -> ConsoleModel {
        let upper = productName.uppercased()
        return all.first { upper.contains($0.name) } ?? .ql5
    }
}

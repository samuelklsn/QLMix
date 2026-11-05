/// A fader / send level as used by the console: integer in 0.01 dB steps,
/// range −138.00 … +10.00 dB, with `-32768` meaning −∞.
public struct FaderLevel: Hashable, Sendable, Comparable, CustomStringConvertible {
    public static let negativeInfinityRaw = -32768
    public static let minRaw = -13800
    public static let maxRaw = 1000

    public static let off = FaderLevel(raw: negativeInfinityRaw)
    public static let unity = FaderLevel(raw: 0)

    public let raw: Int

    public init(raw: Int) {
        if raw <= Self.negativeInfinityRaw || raw < Self.minRaw {
            self.raw = Self.negativeInfinityRaw
        } else {
            self.raw = min(raw, Self.maxRaw)
        }
    }

    /// `nil` for −∞.
    public init(dB: Double?) {
        guard let dB, dB.isFinite else { self.init(raw: Self.negativeInfinityRaw); return }
        self.init(raw: Int((dB * 100).rounded()))
    }

    public var isNegativeInfinity: Bool { raw == Self.negativeInfinityRaw }

    /// Level in dB, `nil` for −∞.
    public var dB: Double? { isNegativeInfinity ? nil : Double(raw) / 100 }

    /// Display string as on the console ("-∞", "-10.0", "+3.5", "0.0").
    public var displayString: String {
        guard let dB else { return "-∞" }
        let rounded = (dB * 10).rounded() / 10
        if rounded > 0 { return "+" + format1(rounded) }
        return format1(rounded)
    }

    public var description: String { displayString }

    private func format1(_ v: Double) -> String {
        let tenths = Int((v * 10).rounded())
        let sign = tenths < 0 ? "-" : ""
        let a = abs(tenths)
        return "\(sign)\(a / 10).\(a % 10)"
    }

    public static func < (lhs: FaderLevel, rhs: FaderLevel) -> Bool { lhs.raw < rhs.raw }

    // MARK: Fader law

    /// Fader taper (position 0…1 ↔ dB), modeled after a typical Yamaha console scale:
    /// 0 dB sits at ~78 % travel, +10 dB at the top, −∞ at the bottom.
    static let taper: [(pos: Double, dB: Double)] = [
        (0.000, -138),
        (0.020, -90),
        (0.060, -70),
        (0.120, -60),
        (0.200, -50),
        (0.280, -40),
        (0.380, -30),
        (0.480, -20),
        (0.560, -15),
        (0.640, -10),
        (0.710, -5),
        (0.780, 0),
        (0.890, 5),
        (1.000, 10),
    ]

    /// Fader position 0…1 for this level.
    public var position: Double {
        guard let dB else { return 0 }
        let t = Self.taper
        // Every finite level stays just above the −∞ snap zone of `init(position:)`.
        let floor = 0.006
        if dB <= t[0].dB { return floor }
        if dB >= t[t.count - 1].dB { return 1 }
        for i in 1..<t.count where dB <= t[i].dB {
            let a = t[i - 1], b = t[i]
            let f = (dB - a.dB) / (b.dB - a.dB)
            return max(floor, a.pos + f * (b.pos - a.pos))
        }
        return 1
    }

    /// Level for a fader position 0…1 (positions below ~0.5 % snap to −∞).
    /// The result is quantized to 0.05 dB steps (0.5 dB below −40 dB) to keep traffic sane.
    public init(position: Double) {
        let p = min(max(position, 0), 1)
        guard p > 0.005 else { self = .off; return }
        let t = Self.taper
        var dB = t[t.count - 1].dB
        for i in 1..<t.count where p <= t[i].pos {
            let a = t[i - 1], b = t[i]
            let f = (p - a.pos) / (b.pos - a.pos)
            dB = a.dB + f * (b.dB - a.dB)
            break
        }
        let step = dB < -40 ? 0.5 : 0.05
        let q = (dB / step).rounded() * step
        self.init(dB: q)
    }

    /// Returns a level nudged by `deltaDB` (used by scroll wheel / keyboard).
    public func adding(dB deltaDB: Double) -> FaderLevel {
        guard let current = dB else {
            return deltaDB > 0 ? FaderLevel(dB: -60) : self
        }
        let next = current + deltaDB
        if next < -100 { return .off }
        return FaderLevel(dB: min(next, Double(Self.maxRaw) / 100))
    }
}

import Foundation

/// Metering via RCP.
///
/// CL/QL consoles expose meters for the Mix and Matrix busses (`mtrinfo` reports
/// `MIXER:Current/Meter/Mix/PostOn` and `MIXER:Current/Meter/Mtrx/PostOn`, range 0…127).
/// A subscription is started with `mtrstart MIXER:Current/Mix/PostOn <interval ms>`; the console
/// then sends `NOTIFY mtr MIXER:Current/Mix/PostOn <name> hh hh …` with one hex byte per channel.
public enum MeterSource: String, CaseIterable, Hashable, Sendable {
    case mixPostOn = "MIXER:Current/Mix/PostOn"
    case matrixPostOn = "MIXER:Current/Mtrx/PostOn"

    public var kind: ChannelKind {
        switch self {
        case .mixPostOn: .mix
        case .matrixPostOn: .matrix
        }
    }

    public init?(address: String) {
        if let s = MeterSource(rawValue: address) { self = s; return }
        // Accept variants with "/Meter/" in the path.
        let normalized = address.replacingOccurrences(of: "Current/Meter/", with: "Current/")
        guard let s = MeterSource(rawValue: normalized) else { return nil }
        self = s
    }
}

public enum MeterScale {
    /// Raw meter value → dBFS (raw 126 ≙ 0 dB).
    public static func dB(raw: Int) -> Double {
        Double(raw) - 126
    }

    /// Normalized display value (0…1) for a meter covering −60 … 0 dB.
    public static func normalized(raw: Int, floorDB: Double = -60) -> Double {
        let db = dB(raw: raw)
        if db <= floorDB { return 0 }
        return min(1, (db - floorDB) / -floorDB)
    }
}

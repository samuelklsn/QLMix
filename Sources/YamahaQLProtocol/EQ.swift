import Foundation

// MARK: - Addressing

/// Address layout of the channel EQ / HPF.
///
/// Yamaha does not publish the EQ part of the CL/QL RCP parameter list. The layout below follows the
/// newer Yamaha consoles (RIVAGE PM, DM7) which use the same RCP dialect:
///
///     MIXER:Current/InCh/PEQ/On                 x = ch          0/1
///     MIXER:Current/InCh/PEQ/Band/Freq          x = ch, y = band  Hz × 10   (200 … 200000)
///     MIXER:Current/InCh/PEQ/Band/Gain          x = ch, y = band  dB × 100  (−1800 … 1800)
///     MIXER:Current/InCh/PEQ/Band/Q             x = ch, y = band  Q × 1000  (100 … 16000)
///     MIXER:Current/InCh/PEQ/LowShelving/On     x = ch          0/1
///     MIXER:Current/InCh/PEQ/HighShelving/On    x = ch          0/1
///     MIXER:Current/InCh/HPF/On                 x = ch          0/1
///     MIXER:Current/InCh/HPF/Freq               x = ch          Hz × 10
///
/// Because this is unconfirmed for CL/QL, the app probes several variants at connect time
/// (`EQSchema.candidates`) and uses the first one the console answers.
public struct EQSchema: Hashable, Sendable {
    public var name: String
    /// Path segment of the parametric EQ block ("PEQ" or "EQ").
    public var eqSegment: String
    public var freqScale: Double
    public var gainScale: Double
    public var qScale: Double
    public var hpfFreqScale: Double

    public static let peq = EQSchema(name: "PEQ", eqSegment: "PEQ", freqScale: 10, gainScale: 100, qScale: 1000, hpfFreqScale: 10)
    public static let eq = EQSchema(name: "EQ", eqSegment: "EQ", freqScale: 10, gainScale: 100, qScale: 1000, hpfFreqScale: 10)

    /// Variants probed at connect time, in order.
    public static let candidates: [EQSchema] = [.peq, .eq]

    /// Address used to detect whether the console supports this schema.
    public func probeAddress(for kind: ChannelKind = .input) -> String {
        EQKey.Parameter.on.address(segment: kind.addressSegment, schema: self)
    }
}

/// Number of parametric bands per channel (CL/QL: 4 – LOW, LOW-MID, HIGH-MID, HIGH).
public let eqBandCount = 4

/// A single EQ / HPF parameter of a channel.
public struct EQKey: Hashable, Sendable {
    public enum Parameter: Hashable, Sendable {
        case on
        case lowShelf
        case highShelf
        case bandFreq(Int)
        case bandGain(Int)
        case bandQ(Int)
        case hpfOn
        case hpfFreq

        func path(schema: EQSchema) -> String {
            switch self {
            case .on: "\(schema.eqSegment)/On"
            case .lowShelf: "\(schema.eqSegment)/LowShelving/On"
            case .highShelf: "\(schema.eqSegment)/HighShelving/On"
            case .bandFreq: "\(schema.eqSegment)/Band/Freq"
            case .bandGain: "\(schema.eqSegment)/Band/Gain"
            case .bandQ: "\(schema.eqSegment)/Band/Q"
            case .hpfOn: "HPF/On"
            case .hpfFreq: "HPF/Freq"
            }
        }

        func address(segment: String, schema: EQSchema) -> String {
            "\(ParameterKey.addressPrefix)\(segment)/\(path(schema: schema))"
        }

        var band: Int? {
            switch self {
            case .bandFreq(let b), .bandGain(let b), .bandQ(let b): b
            default: nil
            }
        }

        /// All parameters of one channel.
        public static var all: [Parameter] {
            [.on, .lowShelf, .highShelf, .hpfOn, .hpfFreq]
                + (0..<eqBandCount).flatMap { [Parameter.bandFreq($0), .bandGain($0), .bandQ($0)] }
        }
    }

    public var channel: ChannelID
    public var parameter: Parameter

    public init(_ channel: ChannelID, _ parameter: Parameter) {
        self.channel = channel
        self.parameter = parameter
    }

    public func address(schema: EQSchema) -> String {
        parameter.address(segment: channel.kind.addressSegment, schema: schema)
    }

    public func wireTargets() -> [(x: Int, y: Int)] {
        channel.kind.wireIndices(for: channel.index).map { ($0, parameter.band ?? 0) }
    }

    /// Decodes a wire address. Returns `nil` for non-EQ addresses and secondary stereo halves.
    public static func decode(address: String, x: Int, y: Int, schema: EQSchema) -> EQKey? {
        guard address.hasPrefix(ParameterKey.addressPrefix) else { return nil }
        let rest = address.dropFirst(ParameterKey.addressPrefix.count)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let segment = String(rest[..<slash])
        let path = String(rest[rest.index(after: slash)...])

        let parameter: Parameter
        switch path {
        case Parameter.on.path(schema: schema): parameter = .on
        case Parameter.lowShelf.path(schema: schema): parameter = .lowShelf
        case Parameter.highShelf.path(schema: schema): parameter = .highShelf
        case Parameter.bandFreq(0).path(schema: schema): parameter = .bandFreq(y)
        case Parameter.bandGain(0).path(schema: schema): parameter = .bandGain(y)
        case Parameter.bandQ(0).path(schema: schema): parameter = .bandQ(y)
        case Parameter.hpfOn.path(schema: schema): parameter = .hpfOn
        case Parameter.hpfFreq.path(schema: schema): parameter = .hpfFreq
        default: return nil
        }
        if let band = parameter.band, !(0..<eqBandCount).contains(band) { return nil }
        for kind in ChannelKind.kinds(forSegment: segment) where kind.hasEQ {
            if let i = kind.logicalIndex(forPrimaryWireIndex: x) {
                return EQKey(ChannelID(kind, i), parameter)
            }
        }
        return nil
    }
}

public extension ChannelKind {
    /// DCAs have no EQ.
    var hasEQ: Bool { self != .dca }
}

public extension RCPCommand {
    static func get(_ key: EQKey, schema: EQSchema) -> RCPCommand {
        let t = key.wireTargets()[0]
        return .get(address: key.address(schema: schema), x: t.x, y: t.y)
    }

    static func set(_ key: EQKey, _ raw: Int, schema: EQSchema) -> [RCPCommand] {
        key.wireTargets().map { .set(address: key.address(schema: schema), x: $0.x, y: $0.y, value: .int(raw)) }
    }
}

// MARK: - Values

/// Engineering-unit EQ state of one channel.
public struct EQSettings: Hashable, Sendable {
    public struct Band: Hashable, Sendable {
        public var frequency: Double   // Hz
        public var gain: Double        // dB
        public var q: Double

        public init(frequency: Double, gain: Double = 0, q: Double = 0.7) {
            self.frequency = frequency
            self.gain = gain
            self.q = q
        }
    }

    public var isOn = true
    public var lowShelf = false
    public var highShelf = false
    public var bands: [Band] = EQSettings.defaultBands
    public var hpfOn = false
    public var hpfFrequency: Double = 80

    public static let defaultBands: [Band] = [
        Band(frequency: 125, q: 0.7),
        Band(frequency: 1000, q: 0.7),
        Band(frequency: 4000, q: 0.7),
        Band(frequency: 10000, q: 0.7),
    ]

    public static let frequencyRange: ClosedRange<Double> = 20...20000
    public static let gainRange: ClosedRange<Double> = -18...18
    public static let qRange: ClosedRange<Double> = 0.1...16
    public static let hpfRange: ClosedRange<Double> = 20...600

    public init() {}

    /// Clamps every value into the console's range.
    public mutating func clamp() {
        for i in bands.indices {
            bands[i].frequency = bands[i].frequency.clamped(to: Self.frequencyRange)
            bands[i].gain = bands[i].gain.clamped(to: Self.gainRange)
            bands[i].q = bands[i].q.clamped(to: Self.qRange)
        }
        hpfFrequency = hpfFrequency.clamped(to: Self.hpfRange)
    }

    /// `true` when all band gains are 0 dB and the HPF is off (nothing to draw).
    public var isFlat: Bool { !hpfOn && bands.allSatisfy { abs($0.gain) < 0.05 } }

    // MARK: Wire conversion

    public func rawValue(for parameter: EQKey.Parameter, schema: EQSchema) -> Int {
        switch parameter {
        case .on: isOn ? 1 : 0
        case .lowShelf: lowShelf ? 1 : 0
        case .highShelf: highShelf ? 1 : 0
        case .hpfOn: hpfOn ? 1 : 0
        case .hpfFreq: Int((hpfFrequency * schema.hpfFreqScale).rounded())
        case .bandFreq(let b): Int((bands[b].frequency * schema.freqScale).rounded())
        case .bandGain(let b): Int((bands[b].gain * schema.gainScale).rounded())
        case .bandQ(let b): Int((bands[b].q * schema.qScale).rounded())
        }
    }

    public mutating func apply(_ parameter: EQKey.Parameter, raw: Int, schema: EQSchema) {
        switch parameter {
        case .on: isOn = raw != 0
        case .lowShelf: lowShelf = raw != 0
        case .highShelf: highShelf = raw != 0
        case .hpfOn: hpfOn = raw != 0
        case .hpfFreq: hpfFrequency = Double(raw) / schema.hpfFreqScale
        case .bandFreq(let b): bands[b].frequency = Double(raw) / schema.freqScale
        case .bandGain(let b): bands[b].gain = Double(raw) / schema.gainScale
        case .bandQ(let b): bands[b].q = Double(raw) / schema.qScale
        }
    }

    // MARK: Frequency response

    /// Band types as displayed / computed.
    public enum BandShape: Sendable {
        case bell, lowShelf, highShelf
    }

    public func shape(of band: Int) -> BandShape {
        if band == 0, lowShelf { return .lowShelf }
        if band == eqBandCount - 1, highShelf { return .highShelf }
        return .bell
    }

    /// Magnitude response in dB at `frequency` (EQ + HPF), using RBJ biquads at 48 kHz.
    public func response(at frequency: Double, sampleRate: Double = 48000) -> Double {
        var total = 0.0
        if isOn {
            for (i, band) in bands.enumerated() where abs(band.gain) >= 0.01 {
                total += Biquad.magnitudeDB(
                    of: Biquad(shape: shape(of: i), frequency: band.frequency, gain: band.gain, q: band.q, sampleRate: sampleRate),
                    at: frequency, sampleRate: sampleRate
                )
            }
        }
        if hpfOn {
            total += Biquad.magnitudeDB(of: .highPass(frequency: hpfFrequency, sampleRate: sampleRate), at: frequency, sampleRate: sampleRate)
        }
        return total
    }

    /// Response of a single band only (for highlighting).
    public func bandResponse(_ index: Int, at frequency: Double, sampleRate: Double = 48000) -> Double {
        let band = bands[index]
        return Biquad.magnitudeDB(
            of: Biquad(shape: shape(of: index), frequency: band.frequency, gain: band.gain, q: band.q, sampleRate: sampleRate),
            at: frequency, sampleRate: sampleRate
        )
    }
}

/// RBJ cookbook biquad (normalized, a0 = 1).
struct Biquad {
    var b0, b1, b2, a1, a2: Double

    init(b0: Double, b1: Double, b2: Double, a0: Double, a1: Double, a2: Double) {
        self.b0 = b0 / a0
        self.b1 = b1 / a0
        self.b2 = b2 / a0
        self.a1 = a1 / a0
        self.a2 = a2 / a0
    }

    init(shape: EQSettings.BandShape, frequency f: Double, gain: Double, q: Double, sampleRate fs: Double) {
        let A = pow(10, gain / 40)
        let w0 = 2 * Double.pi * min(f, fs * 0.49) / fs
        let cosw = cos(w0), sinw = sin(w0)
        let alpha = sinw / (2 * max(q, 0.05))
        switch shape {
        case .bell:
            self.init(b0: 1 + alpha * A, b1: -2 * cosw, b2: 1 - alpha * A,
                      a0: 1 + alpha / A, a1: -2 * cosw, a2: 1 - alpha / A)
        case .lowShelf:
            let s = 2 * sqrt(A) * alpha
            self.init(b0: A * ((A + 1) - (A - 1) * cosw + s),
                      b1: 2 * A * ((A - 1) - (A + 1) * cosw),
                      b2: A * ((A + 1) - (A - 1) * cosw - s),
                      a0: (A + 1) + (A - 1) * cosw + s,
                      a1: -2 * ((A - 1) + (A + 1) * cosw),
                      a2: (A + 1) + (A - 1) * cosw - s)
        case .highShelf:
            let s = 2 * sqrt(A) * alpha
            self.init(b0: A * ((A + 1) + (A - 1) * cosw + s),
                      b1: -2 * A * ((A - 1) + (A + 1) * cosw),
                      b2: A * ((A + 1) + (A - 1) * cosw - s),
                      a0: (A + 1) - (A - 1) * cosw + s,
                      a1: 2 * ((A - 1) - (A + 1) * cosw),
                      a2: (A + 1) - (A - 1) * cosw - s)
        }
    }

    /// 2nd-order Butterworth high-pass (12 dB/oct).
    static func highPass(frequency f: Double, sampleRate fs: Double) -> Biquad {
        let w0 = 2 * Double.pi * f / fs
        let cosw = cos(w0)
        let alpha = sin(w0) / (2 * 0.7071)
        return Biquad(b0: (1 + cosw) / 2, b1: -(1 + cosw), b2: (1 + cosw) / 2,
                      a0: 1 + alpha, a1: -2 * cosw, a2: 1 - alpha)
    }

    static func magnitudeDB(of q: Biquad, at f: Double, sampleRate fs: Double) -> Double {
        let w = 2 * Double.pi * f / fs
        let c1 = cos(w), s1 = sin(w), c2 = cos(2 * w), s2 = sin(2 * w)
        let nr = q.b0 + q.b1 * c1 + q.b2 * c2
        let ni = -(q.b1 * s1 + q.b2 * s2)
        let dr = 1 + q.a1 * c1 + q.a2 * c2
        let di = -(q.a1 * s1 + q.a2 * s2)
        let mag2 = (nr * nr + ni * ni) / max(dr * dr + di * di, 1e-30)
        return 10 * log10(max(mag2, 1e-30))
    }
}

/// Display helpers.
public enum EQFormat {
    public static func frequency(_ hz: Double) -> String {
        if hz >= 1000 {
            let k = hz / 1000
            return k >= 10 ? String(format: "%.1fk", k) : String(format: "%.2fk", k)
        }
        return hz >= 100 ? String(format: "%.0f", hz) : String(format: "%.1f", hz)
    }

    public static func gain(_ dB: Double) -> String {
        let v = (dB * 10).rounded() / 10 + 0  // + 0 turns -0.0 into 0.0
        return v > 0 ? String(format: "+%.1f", v) : String(format: "%.1f", v)
    }

    public static func q(_ q: Double) -> String {
        q >= 10 ? String(format: "%.1f", q) : String(format: "%.2f", q)
    }
}

extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

import Foundation
import Observation
import YamahaQLProtocol

/// Observable state of one logical channel strip. Each strip view observes only
/// its own instance, so meter updates don't invalidate the whole mixer.
@MainActor
@Observable
final class ChannelState: Identifiable {
    let id: ChannelID

    var name: String
    var color: LabelColor
    var level: FaderLevel = .off
    /// The channel "ON" key. `false` == muted.
    var isOn = true
    var cue = false

    /// Send levels to mix busses (key = zero-based mix index).
    var sendLevels: [Int: FaderLevel] = [:]
    var sendOn: [Int: Bool] = [:]

    /// Meter 0…1 (`nil` = no meter data available for this channel).
    var meter: Double?
    var meterPeak: Double = 0

    init(id: ChannelID) {
        self.id = id
        self.name = id.description
        self.color = switch id.kind {
        case .input, .stereoInput: .blue
        case .dca: .yellow
        default: .orange
        }
    }

    func updateMeter(_ value: Double) {
        meter = value
        meterPeak = max(value, meterPeak - 0.015)
    }

    func resetMeter() {
        meter = nil
        meterPeak = 0
    }
}

import SwiftUI
import YamahaQLProtocol

/// EQ editor for the channel selected via `store.eqChannel`.
struct EQInspectorView: View {
    @Environment(MixerStore.self) private var store
    @State private var selectedBand: Int? = 1

    var body: some View {
        VStack(spacing: 0) {
            if let id = store.eqChannel, let channel = store.channel(id) {
                header(channel)
                Divider()
                switch store.eqStatus {
                case .available:
                    editor(channel)
                case .probing, .unknown:
                    statusView(icon: "hourglass", title: store.isConnected ? "Prüfe EQ-Unterstützung …" : "Nicht verbunden",
                               text: "Sobald das Pult antwortet, kann der EQ bearbeitet werden.")
                case .unavailable:
                    unavailableView
                }
            } else {
                statusView(icon: "slider.horizontal.3", title: "Kein Kanal gewählt",
                           text: "Klicke im Kanalzug auf die EQ-Kurve, um den EQ zu öffnen.")
            }
        }
        .frame(minWidth: 460, idealWidth: 520)
        .background(Color(white: 0.1))
    }

    // MARK: Header

    private func header(_ channel: ChannelState) -> some View {
        HStack(spacing: 10) {
            Button { step(-1) } label: { Image(systemName: "chevron.left") }
                .help("Vorheriger Kanal")
            Text(channel.id.description)
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary)
            Text(channel.name)
                .font(.system(size: 14, weight: .bold))
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .foregroundStyle(channel.color.textColor)
                .background(RoundedRectangle(cornerRadius: 4).fill(channel.color.color))
            Button { step(1) } label: { Image(systemName: "chevron.right") }
                .help("Nächster Kanal")
            Spacer()
            Button { store.eqChannel = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .help("EQ schließen")
        }
        .padding(10)
    }

    private func step(_ delta: Int) {
        let all = store.eqChannels
        guard let current = store.eqChannel, let i = all.firstIndex(of: current) else { return }
        store.eqChannel = all[(i + delta + all.count) % all.count]
    }

    // MARK: Editor

    private func editor(_ channel: ChannelState) -> some View {
        let eq = channel.eq
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    StripButton(title: "EQ ON", isOn: eq.isOn, litColor: .green) {
                        store.updateEQ(channel, [.on], immediate: true) { $0.isOn.toggle() }
                    }
                    .frame(width: 80)
                    StripButton(title: "HPF", isOn: eq.hpfOn, litColor: EQColors.hpf) {
                        store.updateEQ(channel, [.hpfOn], immediate: true) { $0.hpfOn.toggle() }
                    }
                    .frame(width: 60)
                    LogSlider(
                        value: eq.hpfFrequency, range: EQSettings.hpfRange,
                        onChange: { v in store.updateEQ(channel, [.hpfFreq]) { $0.hpfFrequency = v } },
                        onEditing: { editing in
                            editing ? store.beginEQTouch(channel, [.hpfFreq]) : store.endEQTouch(channel, [.hpfFreq])
                        }
                    )
                    .frame(maxWidth: 160)
                    Text(EQFormat.frequency(eq.hpfFrequency) + " Hz")
                        .font(.system(size: 11).monospacedDigit())
                        .frame(width: 60, alignment: .leading)
                    Spacer()
                    Button("Flat") { store.flattenEQ(channel) }
                        .help("Alle Bänder auf 0 dB")
                }

                EQGraphView(channel: channel, selectedBand: $selectedBand)
                    .frame(minHeight: 240, idealHeight: 300, maxHeight: 420)

                if !channel.eqSynced {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Lade EQ vom Pult …").font(.caption).foregroundStyle(.secondary)
                    }
                }

                HStack(alignment: .top, spacing: 8) {
                    ForEach(0..<eqBandCount, id: \.self) { i in
                        BandColumn(channel: channel, band: i, isSelected: selectedBand == i)
                            .onTapGesture { selectedBand = i }
                    }
                }

                Text("Knoten ziehen: Frequenz/Gain · Scrollen: Q des gewählten Bands (⌥ fein) · Doppelklick: 0 dB")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
        }
    }

    private var unavailableView: some View {
        statusView(
            icon: "exclamationmark.triangle",
            title: "Pult beantwortet keine EQ-Befehle",
            text: "Dein Pult gibt den EQ über das offene Steuerprotokoll (Port 49280) offenbar nicht frei. Klick bitte auf „Parameterliste auslesen“ und schick mir die gespeicherte Datei (Ordner Dokumente → QLMix). Daran sehe ich, ob und unter welcher Adresse der EQ erreichbar ist."
        ) {
            HStack {
                Button("Erneut prüfen") { store.retryEQProbe() }
                    .disabled(!store.isConnected)
                Button("Parameterliste auslesen") { store.dumpParameterList() }
                    .disabled(!store.isConnected || store.dumpProgress?.isRunning == true)
            }
        }
    }

    private func statusView(icon: String, title: String, text: String) -> some View {
        statusView(icon: icon, title: title, text: text) { EmptyView() }
    }

    private func statusView<Actions: View>(icon: String, title: String, text: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 28)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            actions()
                .padding(.top, 6)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Controls for one EQ band.
private struct BandColumn: View {
    @Environment(MixerStore.self) private var store
    let channel: ChannelState
    let band: Int
    var isSelected: Bool

    var body: some View {
        let eq = channel.eq
        let b = eq.bands[band]
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(Self.names[band])
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(EQColors.bands[band])
                Spacer()
                if band == 0 || band == eqBandCount - 1 {
                    let isShelf = band == 0 ? eq.lowShelf : eq.highShelf
                    Button(isShelf ? "Shelf" : "Bell") {
                        let p: EQKey.Parameter = band == 0 ? .lowShelf : .highShelf
                        store.updateEQ(channel, [p], immediate: true) {
                            if band == 0 { $0.lowShelf.toggle() } else { $0.highShelf.toggle() }
                        }
                    }
                    .controlSize(.mini)
                    .help("Glocke / Kuhschwanz umschalten")
                }
            }

            valueRow("Freq", EQFormat.frequency(b.frequency)) {
                LogSlider(value: b.frequency, range: EQSettings.frequencyRange,
                          onChange: { v in store.updateEQ(channel, [.bandFreq(band)]) { $0.bands[band].frequency = v } },
                          onEditing: touch([.bandFreq(band)]))
            }
            valueRow("Gain", EQFormat.gain(b.gain)) {
                LinearSlider(value: b.gain, range: EQSettings.gainRange, step: 0.5,
                             onChange: { v in store.updateEQ(channel, [.bandGain(band)]) { $0.bands[band].gain = v } },
                             onEditing: touch([.bandGain(band)]))
            }
            valueRow("Q", EQFormat.q(b.q)) {
                LogSlider(value: b.q, range: EQSettings.qRange,
                          onChange: { v in store.updateEQ(channel, [.bandQ(band)]) { $0.bands[band].q = v } },
                          onEditing: touch([.bandQ(band)]))
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(white: isSelected ? 0.17 : 0.13))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isSelected ? EQColors.bands[band].opacity(0.8) : Color.clear, lineWidth: 1)
        )
        .contentShape(Rectangle())
    }

    static let names = ["LOW", "LO-MID", "HI-MID", "HIGH"]

    private func touch(_ params: [EQKey.Parameter]) -> (Bool) -> Void {
        { editing in
            editing ? store.beginEQTouch(channel, params) : store.endEQTouch(channel, params)
        }
    }

    private func valueRow<Content: View>(_ label: String, _ value: String, @ViewBuilder control: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack {
                Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Text(value).font(.system(size: 11, weight: .medium).monospacedDigit())
            }
            control()
        }
    }
}

/// Slider operating in log space (frequency, Q).
struct LogSlider: View {
    var value: Double
    var range: ClosedRange<Double>
    var onChange: (Double) -> Void
    var onEditing: (Bool) -> Void

    var body: some View {
        let lo = log(range.lowerBound), hi = log(range.upperBound)
        Slider(
            value: Binding(
                get: { (log(min(max(value, range.lowerBound), range.upperBound)) - lo) / (hi - lo) },
                set: { onChange(exp(lo + $0 * (hi - lo))) }
            ),
            in: 0...1,
            onEditingChanged: onEditing
        )
        .controlSize(.small)
    }
}

struct LinearSlider: View {
    var value: Double
    var range: ClosedRange<Double>
    var step: Double
    var onChange: (Double) -> Void
    var onEditing: (Bool) -> Void

    var body: some View {
        Slider(
            value: Binding(get: { value }, set: { onChange(($0 / step).rounded() * step) }),
            in: range,
            onEditingChanged: onEditing
        )
        .controlSize(.small)
    }
}

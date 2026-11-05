import SwiftUI
import YamahaQLProtocol

extension LabelColor {
    var color: Color { Color(red: rgb.r, green: rgb.g, blue: rgb.b) }
    /// Readable text color on top of the label color.
    var textColor: Color {
        switch self {
        case .yellow, .cyan, .green, .orange: .black
        default: .white
        }
    }
}

struct ChannelStripView: View {
    @Environment(MixerStore.self) private var store
    let channel: ChannelState
    var width: CGFloat = 74

    @State private var isEditingLabel = false

    var body: some View {
        let sendMode = store.isSendMode(channel.id)
        let level = store.displayedLevel(channel)
        let isOn = store.displayedOn(channel)
        let enabled = store.isConnected

        VStack(spacing: 6) {
            Text(channel.id.description)
                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)

            StripButton(title: "CUE", isOn: channel.cue, litColor: .yellow) {
                store.toggleCue(channel)
            }
            .disabled(!enabled)

            StripButton(title: "ON", isOn: isOn, litColor: sendMode ? .orange : .green) {
                store.toggleOn(channel)
            }
            .disabled(!enabled)

            Text(level.displayString)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(level.isNegativeInfinity ? .secondary : .primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 3).fill(Color.black.opacity(0.5)))

            HStack(spacing: 3) {
                FaderView(
                    level: level,
                    accent: sendMode ? .orange : channel.color.color,
                    isEnabled: enabled,
                    onChange: { store.setLevel($0, for: channel) },
                    onEditingChanged: { editing in
                        editing ? store.beginTouch(channel) : store.endTouch(channel)
                    }
                )
                if channel.meter != nil || store.meterStatus == .active && hasMeter {
                    MeterView(value: channel.meter, peak: channel.meterPeak)
                        .frame(width: 5)
                        .padding(.vertical, 19)
                }
            }
            .frame(maxHeight: .infinity)

            Button {
                isEditingLabel = true
            } label: {
                Text(channel.name.isEmpty ? " " : channel.name)
                    .font(.system(size: 11, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundStyle(channel.color.textColor)
                    .frame(maxWidth: .infinity, minHeight: 22)
                    .background(RoundedRectangle(cornerRadius: 3).fill(channel.color.color))
            }
            .buttonStyle(.plain)
            .help("Name & Farbe bearbeiten")
            .disabled(!enabled)
            .popover(isPresented: $isEditingLabel, arrowEdge: .top) {
                LabelEditor(channel: channel)
            }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 6)
        .frame(width: width)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(sendMode ? Color(red: 0.17, green: 0.13, blue: 0.08) : Color(white: 0.13))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(channel.cue ? Color.yellow.opacity(0.7) : Color.white.opacity(0.06), lineWidth: 1)
        )
        .opacity(isOn ? 1 : 0.82)
    }

    private var hasMeter: Bool {
        MeterSource.allCases.contains { $0.kind == channel.id.kind }
    }
}

struct StripButton: View {
    var title: String
    var isOn: Bool
    var litColor: Color
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(isOn ? Color.black : Color.white.opacity(0.6))
                .frame(maxWidth: .infinity, minHeight: 22)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(isOn ? litColor : Color(white: 0.22))
                        .shadow(color: isOn ? litColor.opacity(0.7) : .clear, radius: 4)
                )
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.black.opacity(0.5), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct LabelEditor: View {
    @Environment(MixerStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let channel: ChannelState
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(channel.id.description).font(.headline)
            TextField("Name (max. 8 Zeichen)", text: $name)
                .textFieldStyle(.roundedBorder)
                .onChange(of: name) { _, new in
                    if new.count > 8 { name = String(new.prefix(8)) }
                }
                .onSubmit(commit)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(28), spacing: 6), count: 5), spacing: 6) {
                ForEach(LabelColor.allCases, id: \.self) { color in
                    Button {
                        store.setColor(color, for: channel)
                    } label: {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(color.color)
                            .frame(width: 28, height: 22)
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .stroke(Color.white, lineWidth: channel.color == color ? 2 : 0)
                            )
                    }
                    .buttonStyle(.plain)
                    .help(color.displayName)
                }
            }
            HStack {
                Spacer()
                Button("Abbrechen") { dismiss() }
                Button("Übernehmen", action: commit).keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(width: 210)
        .onAppear { name = channel.name }
    }

    private func commit() {
        if name != channel.name { store.rename(channel, to: name) }
        dismiss()
    }
}

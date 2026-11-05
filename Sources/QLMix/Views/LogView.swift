import AppKit
import SwiftUI

/// Live protocol log + raw command console (useful for exploring the protocol).
struct LogView: View {
    @Environment(MixerStore.self) private var store
    @Environment(AppSettings.self) private var settings
    @State private var filter = ""
    @State private var command = ""
    @State private var autoScroll = true
    @State private var history: [String] = []

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    var body: some View {
        @Bindable var settings = settings
        @Bindable var log = store.log
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                TextField("Filter", text: $filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                Toggle("Auto-Scroll", isOn: $autoScroll)
                Toggle("Pause", isOn: $log.isPaused)
                Toggle("Meter", isOn: $settings.logMeters)
                Toggle("Keepalive ausblenden", isOn: $settings.hideKeepAlive)
                Spacer()
                Text("\(filtered.count) Einträge").foregroundStyle(.secondary).font(.caption)
                Button("Kopieren") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(store.log.exportText(filtered), forType: .string)
                }
                Button("Leeren") { store.log.clear() }
            }
            .toggleStyle(.checkbox)
            .padding(8)

            HStack(spacing: 10) {
                Button("Parameterliste auslesen") { store.dumpParameterList() }
                    .disabled(!store.isConnected || store.dumpProgress?.isRunning == true)
                    .help("Fragt alle RCP-Parameter des Pults ab (prminfo) und speichert sie als Textdatei")
                dumpStatus
                Spacer()
            }
            .toggleStyle(.checkbox)
            .padding(8)

            Divider()

            ScrollViewReader { proxy in
                List(filtered) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Self.timeFormatter.string(from: entry.date))
                            .foregroundStyle(.secondary)
                        Text(entry.direction.rawValue)
                            .foregroundStyle(color(for: entry.direction))
                            .frame(width: 12)
                        Text(entry.text)
                            .foregroundStyle(entry.text.hasPrefix("ERROR") ? .red : .primary)
                            .textSelection(.enabled)
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .id(entry.id)
                    .listRowSeparator(.hidden)
                }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, 14)
                .onAppear {
                    if let id = filtered.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
                .onChange(of: store.log.entries.last?.id) { _, id in
                    guard autoScroll, let id else { return }
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }

            Divider()

            HStack {
                TextField("RCP-Befehl, z. B.  get MIXER:Current/InCh/Fader/Level 0 0", text: $command)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .onSubmit(sendCommand)
                Menu("Beispiele") {
                    ForEach(Self.examples, id: \.self) { example in
                        Button(example) { command = example }
                    }
                    if !history.isEmpty {
                        Divider()
                        ForEach(history.reversed(), id: \.self) { h in
                            Button(h) { command = h }
                        }
                    }
                }
                .frame(width: 110)
                Button("Senden", action: sendCommand)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!store.isConnected)
            }
            .padding(8)
        }
        .frame(minWidth: 720, minHeight: 380)
    }

    @ViewBuilder
    private var dumpStatus: some View {
        switch store.dumpProgress {
        case .running(let n)?:
            ProgressView().controlSize(.small)
            Text("Lese aus … \(n) Antworten").font(.caption).foregroundStyle(.secondary)
        case let .finished(url, lines)?:
            Text("\(lines) Zeilen gespeichert").font(.caption).foregroundStyle(.secondary)
            Button("Im Finder zeigen") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                .controlSize(.small)
        case .failed(let message)?:
            Text("Fehler: \(message)").font(.caption).foregroundStyle(.red)
        case nil:
            EmptyView()
        }
    }

    private static let examples = [
        "devinfo productname",
        "devinfo version",
        "devstatus runmode",
        "sscurrent_ex MIXER:Lib/Scene",
        "get MIXER:Current/InCh/Fader/Level 0 0",
        "get MIXER:Current/InCh/Label/Name 0 0",
        "get MIXER:Current/InCh/ToMix/Level 0 0",
        "get MIXER:Current/St/Fader/Level 0 0",
        "mtrstart MIXER:Current/Mix/PostOn 100",
        "mtrstop MIXER:Current/Mix/PostOn",
    ]

    private var filtered: [ProtocolLog.Entry] {
        guard !filter.isEmpty else { return store.log.entries }
        return store.log.entries.filter { $0.text.localizedCaseInsensitiveContains(filter) }
    }

    private func color(for direction: ProtocolLog.Direction) -> Color {
        switch direction {
        case .outgoing: .orange
        case .incoming: .green
        case .info: .secondary
        }
    }

    private func sendCommand() {
        let line = command.trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { return }
        store.sendRaw(line)
        history.removeAll { $0 == line }
        history.append(line)
        if history.count > 15 { history.removeFirst() }
        command = ""
    }
}

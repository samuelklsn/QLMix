import SwiftUI
import YamahaQLNetwork
import YamahaQLProtocol

struct MixerView: View {
    @Environment(MixerStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            TopBar()
            Divider()
            LayerBar()
            HStack(spacing: 0) {
                ScrollView(.horizontal) {
                    HStack(spacing: 4) {
                        ForEach(store.strips(for: store.layer)) { channel in
                            ChannelStripView(channel: channel)
                        }
                    }
                    .padding(8)
                    .frame(maxHeight: .infinity)
                }
                .scrollIndicators(.visible)
                .frame(minWidth: 240, maxWidth: .infinity)

                Divider()
                MasterSection()
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(1)
            }
            .overlay {
                if !store.isConnected { DisconnectedOverlay() }
            }
        }
        .background(Color(white: 0.08))
    }
}

/// Fixed section on the right: Stereo/Mono master, or the selected mix master in sends-on-fader mode.
struct MasterSection: View {
    @Environment(MixerStore.self) private var store

    var body: some View {
        HStack(spacing: 4) {
            if case .mix(let mix) = store.faderMode, let master = store.channel(ChannelID(.mix, mix)) {
                ChannelStripView(channel: master, width: 80)
            }
            if let st = store.channel(ChannelID(.stereo, 0)) {
                ChannelStripView(channel: st, width: 80)
            }
            if let mono = store.channel(ChannelID(.mono, 0)) {
                ChannelStripView(channel: mono, width: 80)
            }
        }
        .padding(8)
        .background(Color(white: 0.06))
    }
}

struct LayerBar: View {
    @Environment(MixerStore.self) private var store

    var body: some View {
        @Bindable var store = store
        HStack(spacing: 12) {
            Picker("Ebene", selection: $store.layer) {
                ForEach(store.layers) { layer in
                    Text(layer.title(for: store.model)).tag(layer)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 720)

            Spacer()

            FaderModePicker()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(white: 0.11))
    }
}

struct FaderModePicker: View {
    @Environment(MixerStore.self) private var store

    var body: some View {
        @Bindable var store = store
        HStack(spacing: 6) {
            Text("Fader:")
                .foregroundStyle(.secondary)
            Picker("Fader", selection: $store.faderMode) {
                Text("Main (Kanal-Fader)").tag(FaderMode.main)
                Divider()
                ForEach(0..<store.model.count(.mix), id: \.self) { mix in
                    Text("Sends → MIX \(mix + 1)  \(store.mixName(mix))").tag(FaderMode.mix(mix))
                }
            }
            .labelsHidden()
            .frame(width: 220)
            .help("Sends on Fader: Eingangs-Fader steuern die Sends auf einen Mix-Bus (Monitormix)")
        }
    }
}

struct TopBar: View {
    @Environment(MixerStore.self) private var store
    @Environment(AppSettings.self) private var settings
    @Environment(\.openWindow) private var openWindow
    @State private var sceneInput = ""
    @State private var confirmScene: Int?

    var body: some View {
        @Bindable var settings = settings
        HStack(spacing: 12) {
            ConnectionIndicator(state: store.connectionState)

            TextField("IP-Adresse", text: $settings.host)
                .textFieldStyle(.roundedBorder)
                .frame(width: 140)
                .disabled(store.connectionState != .idle && !isFailed)
                .onSubmit { store.connect() }

            if store.connectionState == .idle || isFailed {
                Button("Verbinden") { store.connect() }
                    .keyboardShortcut("k", modifiers: .command)
            } else {
                Button("Trennen") { store.disconnect() }
                    .keyboardShortcut("k", modifiers: [.command, .shift])
            }

            if let product = store.productName {
                Text(product + (store.firmwareVersion.map { " · \($0)" } ?? ""))
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }
            if store.isSyncing {
                ProgressView().controlSize(.small)
                Text("Synchronisiere …").font(.caption).foregroundStyle(.secondary)
            }

            Spacer()

            sceneControls

            Button {
                openWindow(id: "log")
            } label: {
                Label("Log", systemImage: "list.bullet.rectangle")
            }
            .help("Protokoll-Log öffnen (⌘L)")
            .keyboardShortcut("l", modifiers: .command)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(white: 0.1))
        .confirmationDialog(
            "Szene \(confirmScene ?? 0) aufrufen?",
            isPresented: Binding(get: { confirmScene != nil }, set: { if !$0 { confirmScene = nil } })
        ) {
            Button("Szene \(confirmScene ?? 0) aufrufen", role: .destructive) {
                if let n = confirmScene { store.recallScene(n) }
                confirmScene = nil
            }
        } message: {
            Text("Der aktuelle Mix am Pult wird überschrieben.")
        }
    }

    private var isFailed: Bool {
        if case .failed = store.connectionState { return true }
        return false
    }

    private var sceneControls: some View {
        HStack(spacing: 6) {
            Text("Szene")
                .foregroundStyle(.secondary)
            Text(store.currentScene.map { String(format: "%03d", $0) } ?? "–––")
                .font(.system(.title3, design: .monospaced).weight(.semibold))
                .foregroundStyle(.cyan)
                .frame(minWidth: 40)
            TextField("Nr.", text: $sceneInput)
                .textFieldStyle(.roundedBorder)
                .frame(width: 50)
                .onSubmit(requestRecall)
            Button("Recall", action: requestRecall)
                .disabled(Int(sceneInput) == nil || !store.isConnected)
        }
    }

    private func requestRecall() {
        guard let n = Int(sceneInput), store.isConnected else { return }
        if settings.confirmSceneRecall {
            confirmScene = n
        } else {
            store.recallScene(n)
        }
    }
}

struct ConnectionIndicator: View {
    var state: ConnectionState

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
                .shadow(color: color.opacity(0.8), radius: 3)
            Text(text)
                .font(.callout)
                .lineLimit(1)
                .frame(maxWidth: 260, alignment: .leading)
        }
        .help(text)
    }

    private var color: Color {
        switch state {
        case .connected: .green
        case .connecting, .reconnecting: .orange
        case .failed: .red
        case .idle: .gray
        }
    }

    private var text: String {
        switch state {
        case .idle: "Getrennt"
        case .connecting: "Verbinde …"
        case .connected: "Verbunden"
        case let .reconnecting(attempt, delay, reason):
            "\(reason) – Versuch \(attempt) in \(delay.components.seconds) s"
        case .failed(let reason): reason
        }
    }
}

struct DisconnectedOverlay: View {
    @Environment(MixerStore.self) private var store

    var body: some View {
        ZStack {
            Color.black.opacity(0.35)
                .allowsHitTesting(false)
            VStack(spacing: 10) {
                Image(systemName: "cable.connector.slash")
                    .font(.system(size: 34))
                    .foregroundStyle(.secondary)
                Text(title).font(.headline)
                Text("IP-Adresse oben eingeben und verbinden. Das Pult muss im selben Netz sein (TCP-Port \(store.settings.port)).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                if case .idle = store.connectionState {
                    Button("Verbinden") { store.connect() }.controlSize(.large)
                } else if case .failed = store.connectionState {
                    Button("Erneut verbinden") { store.connect() }.controlSize(.large)
                }
            }
            .padding(24)
            .background(RoundedRectangle(cornerRadius: 12).fill(.regularMaterial))
        }
    }

    private var title: String {
        switch store.connectionState {
        case .connecting: "Verbinde mit Pult …"
        case .reconnecting: "Verbindung verloren – verbinde neu …"
        case .failed: "Verbindung fehlgeschlagen"
        default: "Nicht verbunden"
        }
    }
}

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A private copy is available before the delegate fires, including files supplied by iCloud.
@MainActor final class NativeDocumentPicker: NSObject, UIDocumentPickerDelegate {
    let controller: UIDocumentPickerViewController
    private let complete: (Result<[URL], Error>) -> Void
    init(types: [UTType], multiple: Bool, complete: @escaping (Result<[URL], Error>) -> Void) {
        controller = UIDocumentPickerViewController(forOpeningContentTypes: types.isEmpty ? [.data] : types, asCopy: true)
        controller.allowsMultipleSelection = multiple
        self.complete = complete
        super.init()
        controller.delegate = self
        controller.modalPresentationStyle = .fullScreen
    }
    func present(from parent: UIViewController) {
        parent.view.endEditing(true)
        parent.present(controller, animated: true)
    }
    private func finish(_ result: Result<[URL], Error>) {
        if controller.presentingViewController != nil {
            controller.dismiss(animated: true) { self.complete(result) }
        } else { complete(result) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(.success(urls)) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(.failure(CocoaError(.userCancelled))) }
}

enum NativePickedFile {
    static func discardTemporaryCopy(_ url: URL) {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path
        // Only app-owned temporary copies may be removed; provider originals stay untouched.
        guard url.isFileURL, url.resolvingSymlinksInPath().path.hasPrefix(root.hasSuffix("/") ? root : root + "/") else { return }
        try? FileManager.default.removeItem(at: url)
    }
    static func base64(_ url: URL) async throws -> String {
        guard url.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
        return try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            guard !data.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
            return data.base64EncodedString()
        }.value
    }
}

/// Draws row descriptions from the Swift library snapshots or the remaining web pages.
struct NativePageView: View {
    var waveSource: Binding<NativeWaveSource>? = nil
    @EnvironmentObject private var store: NativeShellStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page: NativePage?
    @State private var failure: String?
    @State private var form: [String: String] = [:]
    @State private var pendingToggles: [String: Bool] = [:]
    @State private var pendingChoices: [String: String] = [:]
    @State private var query = ""
    @State private var running = false
    @State private var reload = 0
    @State private var confirm: (row: NativePageRow.Confirm, act: NativePageAct)?
    @State private var prompt: (row: NativePageRow.Prompt, act: NativePageAct)?
    @State private var promptText = ""
    @State private var documentPicker: NativeDocumentPicker?
    @State private var importingFile: String?
    @State private var importPick: NativeImportPick?
    @State private var heroVisible = true

    var body: some View {
        let current = resolvePage()
        NavigationStack { dialogs(pageList(current), refresh: current?.refresh) }
            .sheet(item: $importPick, onDismiss: { reload &+= 1 }) { target in
                NativeImportPicker(target: target) { choice in
                    if let act = NativePageAct(["name": "resolveImport", "args": ["job": target.job, "position": target.position, "choice": choice]]) { run(act) }
                }.environmentObject(store)
            }
    }

    // Split out of body: as one expression it exceeds the Swift type checker's time limit.
    private func resolvePage() -> NativePage? {
        if let page { return page }
        guard failure == nil, waveSource == nil else { return nil }
        return (try? store.libraryPage()).flatMap(NativePage.init)
    }
    private func isCatalog(_ current: NativePage?) -> Bool { current?.style == "catalog" }
    private func hasHero(_ current: NativePage?) -> Bool {
        if case .hero = current?.sections.first?.rows.first { return true }
        return false
    }
    private var currentPlaylistId: String? {
        guard store.path.hasPrefix("/playlist/") else { return nil }
        let raw = String(store.path.dropFirst("/playlist/".count))
        guard !raw.isEmpty, !raw.contains("/") else { return nil }
        let decoded = raw.removingPercentEncoding ?? raw
        return decoded.isEmpty ? nil : decoded
    }
    private func setHeroVisible(_ visible: Bool) {
        guard heroVisible != visible else { return }
        if reduceMotion { heroVisible = visible }
        else { withAnimation(.easeInOut(duration: 0.18)) { heroVisible = visible } }
    }
    private var nativeImport: Bool { waveSource == nil && store.sharedLibrary && NativeImportState.handles(store.path) }
    /// Smart playlists, duplicates and statistics are native data screens: a shell snapshot must not reload them.
    private var nativeSmart: Bool { waveSource == nil && store.sharedLibrary && NativeSmartState.handles(store.path) }
    /// AutoMix diagnostics reads the JSC API directly: a shell snapshot must not reload and reset its selection.
    private var nativeDiagnostics: Bool { waveSource == nil && store.sharedLibrary && NativeDiagnosticsState.handles(store.path) }

    private func pageList(_ current: NativePage?) -> some View {
        let catalog = isCatalog(current)
        let hero = hasHero(current)
        return styled(List {
            if let name = importingFile { ProgressView("Добавляем «" + name + "»…").frame(maxWidth: .infinity).listRowBackground(Color.clear) }
            if let waveSource { waveHeader(waveSource) }
            if let current {
                if let failure { Text(failure).foregroundStyle(.red) }
                if !hero, let prompt = current.search, !prompt.isEmpty { pageSearchField(prompt) }
                ForEach(Array(current.sections.enumerated()), id: \.offset) { index, section in
                    if hero, index == current.sections.count - 1, let prompt = current.search, !prompt.isEmpty,
                       (section.rows.count >= 6 || !query.isEmpty) {
                        pageSearchField(prompt)
                    }
                    sectionView(section, catalog: catalog, pageTitle: current.title)
                }
            } else if let failure {
                ContentUnavailableView("Не удалось открыть", systemImage: "exclamationmark.triangle", description: Text(failure))
                    .listRowBackground(Color.clear)
                Button("Повторить") { reload &+= 1 }
            } else {
                ProgressView(waveSource == nil ? "Загрузка…" : "Загружаем настройки…").frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }, catalog: catalog)
        .scrollContentBackground(.hidden)
        .background(Color.moraBackground)
        // Only full-bleed hero pages carry their title inside the scroll header; library lists keep navigation titles.
        .navigationTitle(hero ? "" : current?.title ?? "")
        .navigationBarTitleDisplayMode(waveSource == nil && !hero ? .automatic : .inline)
        .toolbar { toolbar(current) }
    }

    private func waveHeader(_ source: Binding<NativeWaveSource>) -> some View {
        let wave = store.ui.wave
        let selected = wave.sources.contains(source.wrappedValue) ? source.wrappedValue : wave.preferred
        let action = wave.button(selected)
        return Section {
            VStack(alignment: .leading, spacing: 12) {
                Label("Ваш ритм", systemImage: "waveform").font(.title2.bold()).foregroundStyle(Color.moraMint)
                Text("Выберите настроение и характер музыки.").font(.subheadline).foregroundStyle(.secondary)
                Picker("Источник волны", selection: source) {
                    ForEach(store.ui.wave.sources, id: \.self) { value in
                        Text(value == .own ? "Коллекция" : value == .online ? "Радио" : "Яндекс").tag(value)
                    }
                }.pickerStyle(.segmented).disabled(running)
                // The sheet stands in for the wave page, so it keeps the way to start or pause the wave.
                Button { store.run("wave", ["source": selected.rawValue]) } label: {
                    Label(action.title, systemImage: action.symbol).font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .foregroundStyle(Color.moraBackground)
                        .background(Color.moraMint.opacity(action.enabled ? 1 : 0.4), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!action.enabled || running)
                .accessibilityIdentifier("wave.play")
            }.padding(.vertical, 6)
        } footer: { Text("Изменения сохраняются автоматически.") }
    }

    @ToolbarContentBuilder private func toolbar(_ current: NativePage?) -> some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if waveSource == nil {
                Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") }
            } else {
                Button { reload &+= 1 } label: { Label("Обновить", systemImage: "arrow.clockwise") }.disabled(running)
            }
        }
        if hasHero(current), !heroVisible, let current {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    Text(current.title)
                        .font(.headline)
                        .lineLimit(1)
                        .foregroundStyle(.white)
                    if case .hero(_, _, _, _, _, let play, _) = current.sections.first?.rows.first, let play {
                        Button { run(play) } label: {
                            Image(systemName: "play.fill")
                                .font(.caption.bold())
                                .foregroundStyle(Color.moraBackground)
                                .frame(width: 28, height: 28)
                                .background(Color.moraMint, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Слушать")
                        .disabled(running)
                    }
                }
                .transition(.opacity)
            }
        }
        if running { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
        if waveSource != nil { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        if current?.sections.contains(where: { $0.reorder != nil }) == true && query.isEmpty {
            ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }
        if let menuItems = current?.menu, !menuItems.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(menuItems.indices, id: \.self) { index in
                        menuControl(menuItems[index])
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(.white.opacity(0.9))
                }
                .accessibilityLabel("Действия")
            }
        }
    }

    @ViewBuilder private func menuControl(_ row: NativePageRow) -> some View {
        switch row {
        case .button(let title, let symbol, let act, let style, let disabled, let confirmRow, let promptRow):
            Button(role: style == "destructive" ? .destructive : nil) {
                if let confirmRow { confirm = (confirmRow, act) }
                else if let promptRow { promptText = promptRow.initial; prompt = (promptRow, act) }
                else { run(act, ["form": form]) }
            } label: {
                if let symbol { Label(title, systemImage: symbol) } else { Text(title) }
            }
            .disabled(disabled || running)

        case .choice(let title, _, let value, let options, let act, let disabled):
            let choiceKey = "\(act.name)|\(act.args["key"] as? String ?? title)"
            let current = pendingChoices[choiceKey] ?? value
            Menu {
                ForEach(options.indices, id: \.self) { index in
                    Button {
                        pendingChoices[choiceKey] = options[index].value
                        run(act, ["value": options[index].value])
                    } label: {
                        if options[index].value == current {
                            Label(options[index].label, systemImage: "checkmark")
                        } else {
                            Text(options[index].label)
                        }
                    }
                }
            } label: {
                Label(title, systemImage: "arrow.up.arrow.down")
            }
            .disabled(disabled || running)

        case .link(let title, _, let symbol, let path):
            Button { store.go(path) } label: {
                if let symbol { Label(title, systemImage: symbol) } else { Text(title) }
            }

        default:
            EmptyView()
        }
    }

    private func dialogs(_ list: some View, refresh: Double?) -> some View {
        list
            .refreshable {
                if ["/catalog/", "/public/", "/soundcloud/"].contains(where: { store.path.hasPrefix($0) }) {
                    if store.sharedLibrary { store.catalog.invalidate() }
                    else { _ = try? await store.call("catalogRefresh") }
                }
                await load()
            }
            .task(id: "\(store.path)|\(nativeImport || nativeSmart || nativeDiagnostics ? 0 : store.revision)|\(reload)|\(waveSource?.wrappedValue.rawValue ?? "")") { await load() }
            .task(id: refresh) {
                guard let seconds = refresh else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(seconds))
                    if !Task.isCancelled { reload &+= 1 }
                }
            }
            .alert(confirm?.row.title ?? "", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), presenting: confirm) { c in
                Button(c.row.button, role: .destructive) { run(c.act) }
                Button("Отмена", role: .cancel) {}
            } message: { c in Text(c.row.text) }
            .alert(prompt?.row.title ?? "", isPresented: Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } }), presenting: prompt) { p in
                TextField(p.row.placeholder, text: $promptText)
                Button("Готово") { run(p.act, ["value": promptText]) }
                Button("Отмена", role: .cancel) {}
            }
            .onAppear {
                heroVisible = true
                if page == nil, waveSource == nil, let local = try? store.libraryPage(), let built = NativePage(local) {
                    page = built
                }
            }
            .onChange(of: store.path) {
                heroVisible = true
                if waveSource == nil, let local = try? store.libraryPage(), let built = NativePage(local) {
                    page = built
                } else {
                    page = nil
                }
                failure = nil; form = [:]; pendingToggles = [:]; pendingChoices = [:]; query = ""
            }
            .onChange(of: waveSource?.wrappedValue) { failure = nil; pendingToggles = [:]; pendingChoices = [:] }
            .safeAreaInset(edge: .bottom) {
                if waveSource != nil, let text = store.banner {
                    Text(text).font(.footnote).padding().frame(maxWidth: .infinity)
                        .background(.ultraThinMaterial).accessibilityIdentifier("wave.message")
                }
            }
    }

    @ViewBuilder private func styled(_ list: some View, catalog: Bool) -> some View {
        if catalog { list.listStyle(.plain) } else { list.listStyle(.insetGrouped) }
    }

    private func pageSearchField(_ prompt: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white.opacity(0.5))
            TextField(prompt, text: $query)
                .foregroundStyle(.white)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.45))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Очистить поиск")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.moraSurfaceElevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    // MARK: rows

    @ViewBuilder private func sectionView(_ section: NativePageSection, catalog: Bool, pageTitle: String) -> some View {
        let words = NativeSearchText.normalize(query).split(whereSeparator: \.isWhitespace)
        let rows = section.rows.enumerated().filter { _, row in
            if words.isEmpty { return true }
            if case .track(let id, _) = row { return store.byId[id].map { t in words.allSatisfy { t.key.contains($0) } } ?? false }
            return row.searchText.map { text in words.allSatisfy { text.contains($0) } } ?? true
        }
        let tracks = rows.compactMap { pair -> NativeTrack? in
            if case .track(let id, _) = pair.element { return store.byId[id] }
            return nil
        }
        if !rows.isEmpty || section.footer != nil {
            Section {
                ForEach(rows, id: \.offset) { _, row in rowView(row, section: section, tracks: tracks, catalog: catalog, pageTitle: pageTitle) }
                    .onMove(perform: section.reorder.flatMap { act -> ((IndexSet, Int) -> Void)? in
                        guard query.isEmpty else { return nil }
                        return { from, to in if let first = from.first { run(act, ["from": first, "to": to]) } }
                    })
                    .listRowBackground(catalog ? Color.moraBackground : Color.moraSurface)
            } header: {
                if let title = section.title {
                    if catalog { Text(title).textCase(nil).font(.title3.bold()).foregroundStyle(.white) }
                    else { Text(title).textCase(nil).font(.footnote.weight(.semibold)) }
                }
            } footer: {
                if let footer = section.footer { Text(footer) }
            }
        }
    }

    private func heroButtons(play: NativePageAct?, shuffle: NativePageAct?, capsule: Bool) -> some View {
        HStack(spacing: 12) {
            if let play {
                Button { run(play) } label: {
                    if capsule {
                        Label("Слушать", systemImage: "play.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.moraBackground)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(Color.moraMint, in: Capsule())
                    } else {
                        Label("Слушать", systemImage: "play.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.moraBackground)
                            .padding(.horizontal, 28)
                            .frame(height: 46)
                            .background(Color.moraMint, in: Capsule())
                    }
                }
                .accessibilityLabel("Слушать")
            }
            if let shuffle {
                Button { run(shuffle) } label: {
                    if capsule {
                        Label("Вперемешку", systemImage: "shuffle")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.moraMint)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(Color.moraSurfaceElevated, in: Capsule())
                            .overlay(Capsule().stroke(Color.white.opacity(0.1), lineWidth: 0.75))
                    } else {
                        Image(systemName: "shuffle")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.moraMint)
                            .frame(width: 46, height: 46)
                            .background(Color.moraSurfaceElevated, in: Circle())
                            .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.75))
                    }
                }
                .accessibilityLabel("Вперемешку")
            }
        }
        .buttonStyle(.plain)
        .disabled(running)
    }

    @ViewBuilder private func rowView(_ row: NativePageRow, section: NativePageSection, tracks: [NativeTrack], catalog: Bool, pageTitle: String) -> some View {
        switch row {
        case .text(let title, let detail, let value, let tone):
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(color(tone) ?? .white)
                    if let detail { Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.6)) }
                }
                Spacer(minLength: 0)
                if let value { Text(value).font(.subheadline.monospacedDigit()).foregroundStyle(color(tone) ?? .white.opacity(0.7)).multilineTextAlignment(.trailing) }
            }
            .accessibilityElement(children: .combine)

        case .toggle(let title, let detail, let on, let act, let disabled):
            let key = "\(act.name)|\(act.args["key"] as? String ?? title)"
            Toggle(isOn: Binding(get: { pendingToggles[key] ?? on }, set: { newValue in
                pendingToggles[key] = newValue
                run(act, ["value": newValue])
            })) { labelled(title, detail) }
                .disabled(disabled || running)

        case .choice(let title, let detail, let value, let options, let act, let disabled):
            let choiceKey = "\(act.name)|\(act.args["key"] as? String ?? title)"
            let current = pendingChoices[choiceKey] ?? value
            if waveSource != nil {
                VStack(alignment: .leading, spacing: 12) {
                    labelled(title, detail)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 8) {
                        ForEach(options.indices, id: \.self) { index in
                            let selected = options[index].value == current
                            Button {
                                pendingChoices[choiceKey] = options[index].value
                                run(act, ["value": options[index].value])
                            } label: {
                                Text(options[index].label).font(.subheadline.weight(.medium)).multilineTextAlignment(.center)
                                    .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 6).padding(.vertical, 4)
                                    .foregroundStyle(selected ? Color.moraMint : Color.white.opacity(0.8))
                                    .background(selected ? Color.moraMint.opacity(0.15) : Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
                                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? Color.moraMint.opacity(0.5) : Color.white.opacity(0.08)))
                            }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }.disabled(disabled || running)
                }.padding(.vertical, 6)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: current)
            } else {
                Picker(selection: Binding(get: { current }, set: { newValue in
                    pendingChoices[choiceKey] = newValue
                    run(act, ["value": newValue])
                })) {
                    ForEach(options.indices, id: \.self) { i in Text(options[i].label).tag(options[i].value) }
                } label: { labelled(title, detail) }
                    .pickerStyle(.menu)
                    .tint(Color.moraMint)
                    .disabled(disabled || running)
            }

        case .slider(let title, let detail, let value, let range, let step, let unit, let act, let disabled):
            NativePageSlider(title: title, detail: detail, value: value, range: range, step: step, unit: unit) { run(act, ["value": $0]) }
                .disabled(disabled || running)

        case .button(let title, let symbol, let act, let style, let disabled, let confirmRow, let promptRow):
            let primary = style == "primary", destructive = style == "destructive"
            Button(role: destructive ? .destructive : nil) {
                if let confirmRow { confirm = (confirmRow, act) }
                else if let promptRow { promptText = promptRow.initial; prompt = (promptRow, act) }
                else { run(act, ["form": form]) }
            } label: {
                if primary {
                    Group { if let symbol { Label(title, systemImage: symbol) } else { Text(title) } }
                        .font(.headline)
                        .foregroundStyle(Color.moraBackground)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(Color.moraMint.opacity(disabled ? 0.4 : 1), in: Capsule())
                } else if destructive {
                    Group { if let symbol { Label(title, systemImage: symbol) } else { Text(title) } }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(Color.red)
                } else if let symbol {
                    HStack(spacing: 12) {
                        NativeIconBadge(symbol: symbol)
                        Text(title).foregroundStyle(.white)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                } else {
                    Text(title).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).foregroundStyle(Color.moraMint)
                        .contentShape(Rectangle())
                }
            }
            .buttonStyle(.plain)
            .listRowBackground(primary ? Color.clear : (catalog ? Color.moraBackground : Color.moraSurface))
            .listRowInsets(primary ? EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0) : EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            .disabled(disabled || running)

        case .link(let title, let detail, let symbol, let path):
            Button { store.go(path) } label: {
                HStack(spacing: 12) {
                    if let symbol { NativeIconBadge(symbol: symbol) }
                    labelled(title, detail)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

        case .url(let title, let url):
            Link(destination: url) {
                HStack(spacing: 12) {
                    NativeIconBadge(symbol: "safari")
                    Text(title).foregroundStyle(.white)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
                }
                .frame(minHeight: 44)
            }

        case .field(let key, let title, let value, let placeholder, let secure, let help):
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.footnote).foregroundStyle(.white.opacity(0.6))
                let text = Binding(get: { form[key] ?? value }, set: { form[key] = $0 })
                Group {
                    if secure { SecureField(placeholder, text: text) } else { TextField(placeholder, text: text) }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .frame(minHeight: 44)
                if let help { Text(help).font(.caption).foregroundStyle(.white.opacity(0.5)) }
            }

        case .file(let title, let symbol, let types, let multiple, let act):
            Button { chooseFiles(types: types.compactMap { UTType(filenameExtension: $0) }, multiple: multiple, act: act) } label: {
                HStack(spacing: 12) {
                    NativeIconBadge(symbol: symbol ?? "doc")
                    Text(title).foregroundStyle(.white).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Image(systemName: "plus").font(.footnote.weight(.semibold)).foregroundStyle(Color.moraMint)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(running)

        case .progress(let title, let value, let detail):
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.subheadline)
                if let value { ProgressView(value: min(1, max(0, value))) } else { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                if let detail { Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.6)) }
            }
            .padding(.vertical, 4)
            .tint(.moraMint)

        case .hero(let style, let title, let subtitle, let detail, let cover, let play, let shuffle):
            let width = UIScreen.main.bounds.width
            if style == "artist" {
                ZStack(alignment: .bottom) {
                    NativeCover(url: cover, size: width, radius: 0, monogram: title)
                        .frame(width: width, height: 310)
                        .clipped()
                        .blur(radius: 34)
                        .opacity(0.5)
                    LinearGradient(
                        colors: [Color.moraBackground.opacity(0.1), Color.moraBackground.opacity(0.65), Color.moraBackground],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    VStack(spacing: 10) {
                        NativeCover(url: cover, size: 142, radius: 71, monogram: title)
                            .overlay(Circle().stroke(Color.moraMint.opacity(0.4), lineWidth: 1.5))
                            .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 1).padding(2))
                            .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
                        Text(title)
                            .font(.system(size: 34, weight: .bold))
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .minimumScaleFactor(0.65)
                            .onAppear { setHeroVisible(true) }
                            .onDisappear { setHeroVisible(false) }
                        if let subtitle, !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.68))
                                .lineLimit(2)
                        }
                        heroButtons(play: play, shuffle: shuffle, capsule: false).padding(.top, 4)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 18)
                }
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Color.moraBackground)
            } else {
                let playlistId = currentPlaylistId
                let collage = playlistId.map { store.playlistCovers(for: $0) } ?? []
                let showCollage = playlistId != nil && collage.count >= 4
                ZStack(alignment: .top) {
                    ZStack(alignment: .bottom) {
                        NativeCover(url: cover ?? collage.first, size: width, radius: 0, monogram: title)
                            .frame(width: width, height: 320)
                            .clipped()
                            .blur(radius: 44)
                            .opacity(0.38)
                        LinearGradient(
                            colors: [Color.moraBackground.opacity(0.1), Color.moraBackground.opacity(0.75), Color.moraBackground],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 320)
                    }
                    VStack(spacing: 8) {
                        Group {
                            if showCollage {
                                NativeCollageCover(urls: collage, size: 220, radius: 14, monogram: title)
                            } else {
                                NativeCover(url: cover, size: 220, radius: 14, monogram: title)
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.12), lineWidth: 0.75))
                        .shadow(color: .black.opacity(0.52), radius: 20, y: 10)
                        .padding(.bottom, 8)
                        Text(title)
                            .font(.title2.bold())
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 16)
                            .onAppear { setHeroVisible(true) }
                            .onDisappear { setHeroVisible(false) }
                        if let subtitle, !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Color.moraMint)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 16)
                        }
                        if let detail, !detail.isEmpty {
                            Text(detail)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(.white.opacity(0.62))
                                .padding(.horizontal, 16)
                        }
                        heroButtons(play: play, shuffle: shuffle, capsule: true)
                            .padding(.horizontal, 16)
                            .padding(.top, 8)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
                    .padding(.bottom, 16)
                }
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Color.moraBackground)
            }

        case .shelf(let items):
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(items) { item in
                        Button { store.go(item.path) } label: {
                            VStack(alignment: item.round ? .center : .leading, spacing: 6) {
                                NativeCover(url: item.cover, size: 150, radius: item.round ? 75 : 12, monogram: item.title)
                                    .overlay(Group {
                                        if item.round {
                                            Circle().stroke(Color.white.opacity(0.16), lineWidth: 1)
                                        } else {
                                            RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 1)
                                        }
                                    })
                                    .shadow(color: .black.opacity(0.45), radius: item.round ? 10 : 6, y: 5)
                                Text(item.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                if let detail = item.subtitle, !detail.isEmpty {
                                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                } else if item.round {
                                    Text("Исполнитель").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }.frame(width: 150, alignment: item.round ? .center : .leading)
                        }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 16)
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 12, trailing: 0)).listRowSeparator(.hidden)

        case .item(let title, let subtitle, let cover, let tag, let tone, let path, let act, let actions, let number):
            HStack(spacing: 12) {
                Button {
                    if let path { store.go(path) } else if let act { run(act) }
                } label: {
                    HStack(spacing: 12) {
                        let isArtist = path?.hasPrefix("/artist/") == true || path?.hasPrefix("/catalog/artist/") == true || path?.hasPrefix("/public/artist/") == true || path?.hasPrefix("/soundcloud/artist/") == true
                        if let number { Text("\(number)").font(.body.monospacedDigit()).foregroundStyle(.secondary).frame(width: 26) }
                        else if cover != nil || isArtist {
                            NativeCover(url: cover ?? nil, size: isArtist ? 52 : 48, radius: isArtist ? 26 : 8, monogram: title)
                                .overlay(Group { if isArtist { Circle().stroke(Color.white.opacity(0.16), lineWidth: 1) } })
                                .shadow(color: .black.opacity(isArtist ? 0.3 : 0), radius: 5, y: 2)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title).font(.body.weight(.medium)).lineLimit(2)
                            if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(color(tone) ?? .white.opacity(0.6)).lineLimit(3) }
                        }
                        Spacer(minLength: 0)
                        if let tag {
                            Text(tag).font(.caption.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 3)
                                .foregroundStyle(color(tone) ?? .white.opacity(0.75))
                                .background((color(tone) ?? .white).opacity(0.14), in: Capsule())
                        }
                        if path != nil { Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35)) }
                    }
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(path == nil && act == nil)
                // A catalog track has eight actions: inline they squeeze the title out of the row, so past two they go in a menu.
                if actions.count > 2 {
                    Menu {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, a in
                            Button(role: a.destructive ? .destructive : nil) { run(a.act) } label: { Label(a.title, systemImage: a.symbol) }
                        }
                    } label: { Image(systemName: "ellipsis").frame(width: 36, height: 44) }
                    .tint(Color.moraMint)
                    .accessibilityLabel("Действия")
                    .disabled(running)
                } else {
                    ForEach(Array(actions.enumerated()), id: \.offset) { _, a in
                        Button(role: a.destructive ? .destructive : nil) { run(a.act) } label: {
                            Image(systemName: a.symbol).frame(width: 36, height: 44)
                        }
                        .buttonStyle(.borderless)
                        .tint(a.destructive ? Color.red : Color.moraMint)
                        .accessibilityLabel(a.title)
                        .disabled(running)
                    }
                }
            }
            .contextMenu {
                ForEach(Array(actions.enumerated()), id: \.offset) { _, a in
                    Button(role: a.destructive ? .destructive : nil) { run(a.act) } label: { Label(a.title, systemImage: a.symbol) }
                }
            }
            .accessibilityElement(children: .contain)

        case .track(let id, let remove):
            if let track = store.byId[id] {
                NativeTrackRow(track: track, play: {
                    guard let i = tracks.firstIndex(where: { $0.id == id }) else { return }
                    let ctx = section.play ?? [:]
                    store.play(tracks, at: i, type: ctx["type"] as? String ?? "library", label: ctx["label"] as? String ?? pageTitle, id: ctx["id"] as? String)
                }, remove: remove.map { r in (r.title, r.symbol, { run(r.act) }) })
            }
        }
    }

    private func labelled(_ title: String, _ detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            if let detail { Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.6)) }
        }
    }

    private func color(_ tone: NativeTone?) -> Color? {
        switch tone {
        case .ok, .accent: return .moraMint
        case .warn: return .moraGold
        case .error: return Color(red: 1, green: 0.55, blue: 0.5)
        case nil: return nil
        }
    }

    // MARK: page calls

    @MainActor private func load() async {
        do {
            let value: Any?
            if waveSource == nil, store.sharedLibrary, NativeImportState.handles(store.path) {
                value = try await store.imports.page(store.path, request: { try await NativeServerApp.request($0, $1, body: $2) })
            }
            else if waveSource == nil, store.sharedLibrary, NativeSmartState.handles(store.path) {
                value = try await store.smart.page(store.path, request: { try await NativeServerApp.request($0, $1, body: $2) })
            }
            else if waveSource == nil, store.sharedLibrary, NativeDiagnosticsState.handles(store.path) {
                value = try await store.diagnostics.page(store.path, name: { store.byId[$0]?.title }, automix: store.ui.playback.automix,
                                                         request: { try await NativeServerApp.request($0, $1, body: $2) })
            }
            else if let waveSource, store.sharedLibrary {
                value = try await store.wave.settingsPage(waveSource.wrappedValue.rawValue, request: { try await NativeServerApp.request($0, $1, body: $2) })
            }
            else if waveSource == nil, store.sharedLibrary, NativeWaveState.handles(store.path) {
                value = try await store.wave.page(source: store.waveSource?.rawValue, ui: store.ui, byId: store.byId, libraryCount: store.library.count,
                                                  request: { try await NativeServerApp.request($0, $1, body: $2) })
            }
            else if waveSource == nil, store.sharedLibrary, NativeCatalogState.handles(store.path) {
                value = try await store.catalog.page(store.path,
                                                     request: { try await NativeServerApp.request($0, $1, body: $2) },
                                                     localLookup: { store.localCatalogTrack(provider: $0, externalId: $1) })
            }
            else if waveSource == nil, NativeRoute.screen(store.path) != .page || (store.sharedLibrary && NativeShellStore.ownScreens.contains(store.path)) {
                return // the shell already replaced this view with its own screen for that route
            }
            else if waveSource == nil, let local = try store.libraryPage() { value = local }
            else { value = try await store.call(waveSource == nil ? "page" : "waveSettings", waveSource.map { ["source": $0.wrappedValue.rawValue] } ?? [:]) }
            guard !Task.isCancelled else { return }
            page = NativePage(value)
            pendingToggles.removeAll()
            pendingChoices.removeAll()
            failure = nil
        } catch {
            guard !Task.isCancelled else { return }
            failure = Self.message(error)
        }
    }

    /// Local library actions use the native server; remaining actions use the page.
    private func run(_ act: NativePageAct, _ extra: [String: Any] = [:]) {
        guard !running else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let args = act.args.merging(extra) { _, new in new }
        if store.sharedLibrary, NativeImportState.handles(store.path), act.name == "pickImport" {
            do { importPick = try store.imports.pick(args["position"] as? Int ?? -1) }
            catch { store.show(error.localizedDescription) }
            return
        }
        if act.name == "playlistSort", let id = args["id"] as? String, let value = args["value"] as? String,
           (try? store.libraryPage()) != nil {
            store.playlistSort[id] = value
            reload &+= 1
            return
        }
        running = true
        Task { @MainActor in
            defer { running = false; reload &+= 1 }
            do {
                if store.sharedLibrary, NativeImportState.handles(store.path), NativeImportState.supports(act.name) {
                    let result = try await store.imports.execute(act.name, args, request: { try await NativeServerApp.request($0, $1, body: $2, timeout: 120) })
                    if result.mutated {
                        do { try await store.refreshLibraryAfterMutation() }
                        catch { store.show("Импорт сохранён. Не удалось обновить медиатеку: \(error.localizedDescription)"); return }
                    }
                    if let message = result.message { store.show(message) }
                    if let path = result.path { store.go(path) }
                    return
                }
                if store.sharedLibrary, NativeSmartState.handles(store.path), NativeSmartState.supports(act.name) {
                    let result = try await store.smart.execute(act.name, args, request: { try await NativeServerApp.request($0, $1, body: $2, timeout: 120) })
                    if result.mutated {
                        do { try await store.refreshLibraryAfterMutation() }
                        catch { store.show("Сохранено. Не удалось обновить медиатеку: \(error.localizedDescription)"); return }
                    }
                    if let message = result.message { store.show(message) }
                    if let path = result.path { store.go(path) }
                    return
                }
                if store.sharedLibrary, NativeDiagnosticsState.handles(store.path), NativeDiagnosticsState.supports(act.name) {
                    _ = try await store.diagnostics.execute(act.name, args, request: { try await NativeServerApp.request($0, $1, body: $2) })
                    return
                }
                if store.sharedLibrary, (waveSource != nil || NativeWaveState.handles(store.path)) {
                    if NativeWaveState.supports(act.name) {
                        if let message = try await store.wave.execute(act.name, args, request: { try await NativeServerApp.request($0, $1, body: $2) }) {
                            store.show(message)
                        }
                        return
                    }
                    if act.name == "waveSource", let value = args["value"] as? String, let src = NativeWaveSource(rawValue: value) {
                        store.waveSource = src
                        return
                    }
                    if act.name == "waveLaunch" {
                        let src = args["source"] as? String ?? store.waveSource?.rawValue ?? "own"
                        try await NativeQueueController.shared.startWave(source: src, offline: store.offline)
                        return
                    }
                    if act.name == "queue" {
                        store.openPlayer()
                        return
                    }
                    if act.name == "jump", let idx = (args["index"] as? NSNumber)?.intValue {
                        let entries = NativeQueueController.shared.entries
                        if entries.indices.contains(idx) {
                            try await NativeQueueController.shared.editQueue(action: "jump", entryId: entries[idx].entryId)
                            return
                        }
                    }
                }
                if store.sharedLibrary, NativeCatalogState.handles(store.path), NativeCatalogState.supports(act.name) {
                    try await store.catalog.execute(act.name, args, request: { try await NativeServerApp.request($0, $1, body: $2) })
                    return
                }
                if store.sharedLibrary, try await store.executeCatalogPageAction(act.name, args) { return }
                if store.sharedLibrary, try await store.executeNativePlaybackCommand(act.name, args) { return }
                if try await store.executeLibraryAction(act.name, args) { return }
                let result = try await store.call("act", ["name": act.name, "args": args], timeout: 120) as? [String: Any]
                if let share = result?["share"] as? [String: Any], let name = share["name"] as? String, let text = share["text"] as? String { self.share(name, text) }
                if let path = result?["go"] as? String { store.go(path) }
                if let id = result?["versions"] as? String { store.presentVersions(id: id) }
            } catch {
                store.show(Self.message(error))
            }
        }
    }

    /// Shared-library imports use private file copies; OPFS and remaining file actions keep the old bridge.
    private func chooseFiles(types: [UTType], multiple: Bool, act: NativePageAct) {
        guard documentPicker == nil, let root = store.presenter else { return }
        var parent = root
        while let presented = parent.presentedViewController { parent = presented }
        let picker = NativeDocumentPicker(types: types, multiple: multiple) { result in
            documentPicker = nil
            switch result {
            case .success(let urls):
                if urls.isEmpty { store.show("Файлы не выбраны") } else { send(urls, act) }
            case .failure(let error):
                if (error as NSError).code != CocoaError.Code.userCancelled.rawValue { store.show(Self.message(error)) }
            }
        }
        documentPicker = picker
        picker.present(from: parent)
    }

    private func send(_ urls: [URL], _ act: NativePageAct) {
        running = true
        Task { @MainActor in
            defer { running = false; importingFile = nil; reload &+= 1 }
            var added = 0, duplicates = 0
            var errors: [String] = []
            for url in urls {
                defer { NativePickedFile.discardTemporaryCopy(url) }
                importingFile = url.lastPathComponent
                do {
                    if store.sharedLibrary && act.name == "importAudio" {
                        let staged = try await Task.detached(priority: .userInitiated) { try NativeImportFiles.stage(url, root: NativeServerApp.root) }.value
                        let result = try await NativeServerApp.request("POST", "/api/mobile/import-file", body: ["file": staged.file, "name": staged.name], timeout: 300)
                        if result["duplicate"] as? Bool == true { duplicates += 1 } else { added += 1 }
                        store.refreshLibrary()
                        continue
                    }
                    if store.sharedLibrary && act.name == "setTrackArtwork" {
                        guard let id = act.args["id"] as? String, id.range(of: "^[A-Za-z0-9._-]{1,100}$", options: .regularExpression) != nil else {
                            throw NativeLibraryActions.Failure(message: "Трек не найден")
                        }
                        let base64 = try await NativePickedFile.base64(url)
                        _ = try await NativeServerApp.request("POST", "/api/tracks/\(id)/artwork", body: ["base64": base64], timeout: 90)
                        store.refreshLibrary()
                        continue
                    }
                    if store.sharedLibrary && act.name == "importFile" {
                        let body = try await Task.detached(priority: .userInitiated) { try NativeImportFiles.playlist(url) }.value
                        try await store.imports.start(body, request: { try await NativeServerApp.request($0, $1, body: $2) })
                        continue
                    }
                    let base64 = try await NativePickedFile.base64(url)
                    let args = act.args.merging(["name": url.lastPathComponent, "base64": base64]) { _, new in new }
                    _ = try await store.call("act", ["name": act.name, "args": args], timeout: 300)
                } catch {
                    errors.append(url.lastPathComponent + ": " + Self.message(error))
                    store.show("\(url.lastPathComponent): \(Self.message(error))")
                }
            }
            if store.sharedLibrary && act.name == "importAudio" {
                store.show("Добавлено: \(added) · уже были: \(duplicates) · ошибок: \(errors.count)" + (errors.first.map { "\n" + $0 } ?? ""))
            }
        }
    }

    private func share(_ name: String, _ text: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        guard (try? text.write(to: url, atomically: true, encoding: .utf8)) != nil, let presenter = store.presenter else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = presenter.view
        (presenter.presentedViewController ?? presenter).present(sheet, animated: true)
    }

    private static func message(_ error: Error) -> String {
        (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
    }
}

/// Keeps the value while dragging and sends it once, as the web range input does on release.
private struct NativePageSlider: View {
    let title: String, detail: String?
    let value: Double, range: ClosedRange<Double>, step: Double, unit: String
    let commit: (Double) -> Void
    @State private var shown: Double?

    var body: some View {
        let v = shown ?? value
        let text = "\(step < 1 ? String(format: "%.1f", v) : String(Int(v))) \(unit)"
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text(text).font(.subheadline.monospacedDigit()).foregroundStyle(.white.opacity(0.7))
            }
            Slider(value: Binding(get: { v }, set: { shown = $0 }), in: range, step: step, onEditingChanged: { editing in
                if !editing, let shown { commit(shown); self.shown = nil }
            })
            .tint(.moraMint)
            .accessibilityLabel(title)
            .accessibilityValue(text)
            if let detail { Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.6)) }
        }
        .padding(.vertical, 4)
    }
}

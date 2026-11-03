import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Native pages described by the page (apps/web/src/lib/native-pages.ts): albums, artists, playlists,
/// history, wave, downloads, import, sources, settings and diagnostics. The page owns the data and the
/// actions; this view draws the rows (NativeShellState.swift, `NativePage`) and sends the actions back.
struct NativePageView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var page: NativePage?
    @State private var failure: String?
    @State private var form: [String: String] = [:]
    @State private var query = ""
    @State private var running = false
    @State private var reload = 0
    @State private var confirm: (row: NativePageRow.Confirm, act: NativePageAct)?
    @State private var prompt: (row: NativePageRow.Prompt, act: NativePageAct)?
    @State private var promptText = ""
    @State private var picker = false
    /// Kept after the picker closes: its completion can arrive after `picker` is reset.
    @State private var pick: (types: [UTType], multiple: Bool, act: NativePageAct)?

    var body: some View {
        NavigationStack { dialogs(pageList) }
    }

    // Split out of body: as one expression it exceeds the Swift type checker's time limit.
    private var pageList: some View {
        withSearch(List {
            if let page {
                ForEach(Array(page.sections.enumerated()), id: \.offset) { _, section in sectionView(section) }
            } else if let failure {
                ContentUnavailableView("Не удалось открыть", systemImage: "exclamationmark.triangle", description: Text(failure))
                    .listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        })
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.moraBackground)
        .navigationTitle(page?.title ?? "")
        .toolbar { toolbar }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") }
        }
        if running { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
        if page?.sections.contains(where: { $0.reorder != nil }) == true && query.isEmpty {
            ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }
    }

    private func dialogs(_ list: some View) -> some View {
        list
            .refreshable { await load() }
            .task(id: "\(store.path)|\(store.revision)|\(reload)") { await load() }
            .task(id: page?.refresh) {
                guard let seconds = page?.refresh else { return }
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
            .fileImporter(isPresented: $picker, allowedContentTypes: pick?.types ?? [.data], allowsMultipleSelection: pick?.multiple ?? false) { result in
                guard let act = pick?.act, case .success(let urls) = result else { return }
                send(urls, act)
            }
            .onChange(of: store.path) { page = nil; failure = nil; form = [:]; query = "" }
    }

    @ViewBuilder private func withSearch(_ list: some View) -> some View {
        if let prompt = page?.search {
            list.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        } else {
            list
        }
    }

    // MARK: rows

    @ViewBuilder private func sectionView(_ section: NativePageSection) -> some View {
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
                ForEach(rows, id: \.offset) { _, row in rowView(row, section: section, tracks: tracks) }
                    .onMove(perform: section.reorder.flatMap { act -> ((IndexSet, Int) -> Void)? in
                        guard query.isEmpty else { return nil }
                        return { from, to in if let first = from.first { run(act, ["from": first, "to": to]) } }
                    })
                    .listRowBackground(Color.white.opacity(0.06))
            } header: {
                if let title = section.title { Text(title) }
            } footer: {
                if let footer = section.footer { Text(footer) }
            }
        }
    }

    @ViewBuilder private func rowView(_ row: NativePageRow, section: NativePageSection, tracks: [NativeTrack]) -> some View {
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
            Toggle(isOn: Binding(get: { on }, set: { run(act, ["value": $0]) })) { labelled(title, detail) }
                .disabled(disabled || running)

        case .choice(let title, let detail, let value, let options, let act, let disabled):
            Picker(selection: Binding(get: { value }, set: { run(act, ["value": $0]) })) {
                ForEach(options.indices, id: \.self) { i in Text(options[i].label).tag(options[i].value) }
            } label: { labelled(title, detail) }
                .pickerStyle(.menu)
                .disabled(disabled || running)

        case .slider(let title, let detail, let value, let range, let step, let unit, let act, let disabled):
            NativePageSlider(title: title, detail: detail, value: value, range: range, step: step, unit: unit) { run(act, ["value": $0]) }
                .disabled(disabled || running)

        case .button(let title, let symbol, let act, let style, let disabled, let confirmRow, let promptRow):
            Button(role: style == "destructive" ? .destructive : nil) {
                if let confirmRow { confirm = (confirmRow, act) }
                else if let promptRow { promptText = promptRow.initial; prompt = (promptRow, act) }
                else { run(act, ["form": form]) }
            } label: {
                Group {
                    if let symbol { Label(title, systemImage: symbol) } else { Text(title) }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: style == "primary" ? .center : .leading)
                .fontWeight(style == "primary" ? .semibold : .regular)
                .foregroundStyle(style == "primary" ? Color.moraBackground : style == "destructive" ? Color.red : Color.moraMint)
            }
            .listRowBackground(style == "primary" ? Color.moraMint.opacity(disabled ? 0.4 : 1) : Color.white.opacity(0.06))
            .disabled(disabled || running)

        case .link(let title, let detail, let symbol, let path):
            Button { store.go(path) } label: {
                HStack(spacing: 12) {
                    if let symbol { Image(systemName: symbol).foregroundStyle(Color.moraMint).frame(width: 24) }
                    labelled(title, detail)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

        case .url(let title, let url):
            Link(destination: url) { Label(title, systemImage: "arrow.up.right.square").frame(minHeight: 44) }

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
            Button { pick = (types.compactMap { UTType(filenameExtension: $0) }, multiple, act); picker = true } label: {
                Label(title, systemImage: symbol ?? "doc").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .disabled(running)

        case .progress(let title, let value, let detail):
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.subheadline)
                if let value { ProgressView(value: min(1, max(0, value))) } else { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                if let detail { Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.6)) }
            }
            .padding(.vertical, 4)
            .tint(.moraMint)

        case .item(let title, let subtitle, let cover, let tag, let tone, let path, let act, let actions):
            HStack(spacing: 12) {
                Button {
                    if let path { store.go(path) } else if let act { run(act) }
                } label: {
                    HStack(spacing: 12) {
                        if let cover { NativeCover(url: cover, size: 48) }
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
            .accessibilityElement(children: .contain)

        case .track(let id, let remove):
            if let track = store.byId[id] {
                NativeTrackRow(track: track, play: {
                    guard let i = tracks.firstIndex(where: { $0.id == id }) else { return }
                    let ctx = section.play ?? [:]
                    store.play(tracks, at: i, type: ctx["type"] as? String ?? "library", label: ctx["label"] as? String ?? page?.title ?? "", id: ctx["id"] as? String)
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
            let value = try await store.call("page")
            guard !Task.isCancelled else { return }
            page = NativePage(value)
            failure = nil
        } catch {
            guard !Task.isCancelled else { return }
            failure = Self.message(error)
        }
    }

    /// Runs a row action in the page, then follows what it asks for and reloads the page.
    private func run(_ act: NativePageAct, _ extra: [String: Any] = [:]) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let args = act.args.merging(extra) { _, new in new }
        running = true
        Task { @MainActor in
            defer { running = false; reload &+= 1 }
            do {
                let result = try await store.call("act", ["name": act.name, "args": args], timeout: 120) as? [String: Any]
                if let share = result?["share"] as? [String: Any], let name = share["name"] as? String, let text = share["text"] as? String { self.share(name, text) }
                if let path = result?["go"] as? String { store.go(path) }
            } catch {
                store.show(Self.message(error))
            }
        }
    }

    /// Picked files go to the page one by one as base64.
    /// shortcut: a whole file is read into memory and copied across the bridge; fine for songs, upgrade to a
    /// streamed upload if multi-hundred-megabyte files must be imported.
    private func send(_ urls: [URL], _ act: NativePageAct) {
        running = true
        Task { @MainActor in
            defer { running = false; reload &+= 1 }
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do {
                    let data = try Data(contentsOf: url)
                    let args = act.args.merging(["name": url.lastPathComponent, "base64": data.base64EncodedString()]) { _, new in new }
                    _ = try await store.call("act", ["name": act.name, "args": args], timeout: 300)
                } catch {
                    store.show("\(url.lastPathComponent): \(Self.message(error))")
                }
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

// The in-app server in JavaScriptCore (ios/App/App/NativeServer.swift): the same boot as the
// WebView worker, on real files and SQLite. The prelude's globals must exist before any server module runs.
import './prelude.ts';
import '../worker/main.ts';

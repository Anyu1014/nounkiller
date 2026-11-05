import UIKit
import WebKit

/// NounKiller iOS 壳：WKWebView 加载随包的 www，状态经 UserDefaults 持久化。
/// 网页端是唯一逻辑源，这里只补系统集成（安全区、键盘、返回手势）。
final class ViewController: UIViewController {

    private static let stateKey = "nounkiller.state.v1"
    private static let legacyStateKey = "mingjiezhan.state.v1"

    private var webView: WKWebView!
    private var bottomConstraint: NSLayoutConstraint!
    private var keyboardOffset: CGFloat = 0

    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.953, green: 0.941, blue: 0.910, alpha: 1)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.dataDetectorTypes = []

        let controller = WKUserContentController()
        controller.add(self, name: "nounkillerState")
        let savedState = UserDefaults.standard.string(forKey: Self.stateKey)
            ?? UserDefaults.standard.string(forKey: Self.legacyStateKey)
        if let saved = savedState, !saved.isEmpty {
            let base64 = Data(saved.utf8).base64EncodedString()
            let js = "window.__NOUNKILLER_STATE__ = decodeURIComponent(escape(atob('\(base64)')));"
            controller.addUserScript(WKUserScript(
                source: js,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        config.userContentController = controller

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        // 固定缩放：双击与双指都不改变页面比例
        webView.scrollView.bouncesZoom = false
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        if #available(iOS 16.4, *) {
            webView.isInspectable = false
        }

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        ])
        bottomConstraint = webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        bottomConstraint.isActive = true

        loadWebApp()
        observeKeyboard()
    }

    private func loadWebApp() {
        guard let www = Bundle.main.url(forResource: "www", withExtension: nil) else {
            assertionFailure("www folder missing from app bundle")
            return
        }
        let index = www.appendingPathComponent("index.html")
        webView.loadFileURL(index, allowingReadAccessTo: www)
    }

    // MARK: - 键盘避让

    private func observeKeyboard() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillChange(_:)),
                           name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillHide(_:)),
                           name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let keyboardTop = view.convert(frame, from: nil).minY
        let safeBottom = view.safeAreaLayoutGuide.layoutFrame.maxY
        setKeyboardOffset(max(0, safeBottom - keyboardTop), note: note)
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        setKeyboardOffset(0, note: note)
    }

    private func setKeyboardOffset(_ offset: CGFloat, note: Notification) {
        guard abs(offset - keyboardOffset) > 0.5 else { return }
        keyboardOffset = offset
        bottomConstraint.constant = -offset
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseInOut]) {
            self.view.layoutIfNeeded()
        }
    }
}

// MARK: - 原生状态桥

extension ViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "nounkillerState", let state = message.body as? String else { return }
        UserDefaults.standard.set(state, forKey: Self.stateKey)
    }
}

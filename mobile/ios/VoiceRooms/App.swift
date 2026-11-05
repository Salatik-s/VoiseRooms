import UIKit
import WebKit
import AVFoundation

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var controller: VoiceViewController?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let view = VoiceViewController()
        controller = view
        let window = UIWindow(windowScene: scene)
        window.rootViewController = view
        window.makeKeyAndVisible()
        self.window = window
        if let url = options.urlContexts.first?.url { view.openInvitation(url) }
    }
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        if let url = contexts.first?.url { controller?.openInvitation(url) }
    }
}

final class VoiceViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let origin = URL(string: "https://voise.24projects.ru/")!
    private var web: WKWebView!
    private let errorView = UIStackView()
    private let progress = UIActivityIndicatorView(style: .large)
    private var lastURL: URL?
    private var pendingInvitation: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.09, green: 0.10, blue: 0.11, alpha: 1)
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        prepareFailureView()
        progress.color = .systemBlue
        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progress)
        NSLayoutConstraint.activate([progress.centerXAnchor.constraint(equalTo: view.centerXAnchor), progress.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        load(pendingInvitation ?? initialURL())
    }
    private func initialURL() -> URL {
        #if DEBUG && targetEnvironment(simulator)
        let args = ProcessInfo.processInfo.arguments
        if let position = args.firstIndex(of: "-previewURL"), position + 1 < args.count,
           let url = URL(string: args[position + 1]), trusted(url) { return url }
        #endif
        return origin
    }
    private func trusted(_ url: URL) -> Bool {
        if url.scheme == "https" && url.host == origin.host && (url.port == nil || url.port == 443) { return true }
        #if DEBUG && targetEnvironment(simulator)
        return url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost")
        #else
        return false
        #endif
    }
    func openInvitation(_ url: URL) {
        guard url.scheme == "voicerooms", var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        components.scheme = "https"
        components.host = origin.host
        components.port = nil
        components.path = "/"
        components.user = nil
        components.password = nil
        guard let destination = components.url else { return }
        if isViewLoaded { load(destination) } else { pendingInvitation = destination }
    }
    private func load(_ url: URL) {
        guard trusted(url) else { return }
        lastURL = url
        errorView.isHidden = true
        web.isHidden = false
        progress.startAnimating()
        web.load(URLRequest(url: url))
    }
    private func prepareFailureView() {
        errorView.axis = .vertical
        errorView.alignment = .center
        errorView.spacing = 20
        errorView.translatesAutoresizingMaskIntoConstraints = false
        let icon = UIImageView(image: UIImage(systemName: "wifi.slash"))
        icon.tintColor = .secondaryLabel
        icon.contentMode = .scaleAspectFit
        icon.heightAnchor.constraint(equalToConstant: 44).isActive = true
        icon.widthAnchor.constraint(equalToConstant: 44).isActive = true
        let title = UILabel()
        title.text = "Не удалось открыть VoiceRooms"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        title.textAlignment = .center
        title.numberOfLines = 0
        let message = UILabel()
        message.text = "Проверьте подключение к интернету и попробуйте ещё раз."
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.textColor = .secondaryLabel
        message.textAlignment = .center
        message.numberOfLines = 0
        let retry = UIButton(type: .system)
        retry.setTitle("Попробовать снова", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        retry.addTarget(self, action: #selector(retryLoading), for: .touchUpInside)
        [icon, title, message, retry].forEach { errorView.addArrangedSubview($0) }
        view.addSubview(errorView)
        NSLayoutConstraint.activate([errorView.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor), errorView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28), errorView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28)])
        errorView.isHidden = true
    }
    @objc private func retryLoading() { load(lastURL ?? origin) }
    private func fail() {
        progress.stopAnimating()
        web.isHidden = true
        errorView.isHidden = false
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.stopAnimating()
        errorView.isHidden = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if trusted(url) && !url.path.hasPrefix("/downloads/") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if (url.scheme == "https" || url.scheme == "http") && action.navigationType == .linkActivated { UIApplication.shared.open(url) }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" { UIApplication.shared.open(url) }
        return nil
    }
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard origin.protocol == "https", origin.host == self.origin.host, type == .microphone else { decisionHandler(.deny); return }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async {
                if granted {
                    try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
                    try? AVAudioSession.sharedInstance().setActive(true)
                }
                decisionHandler(granted ? .grant : .deny)
            }
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "Подтвердите действие", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Подтвердить", style: .destructive) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "VoiceRooms", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
}

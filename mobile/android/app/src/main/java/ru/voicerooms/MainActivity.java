package ru.voicerooms;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.*;
import android.net.http.SslError;
import android.os.*;
import android.provider.MediaStore;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.OutputStream;
import java.util.*;
import org.json.JSONObject;

public class MainActivity extends Activity {

  public static final String ACTION_END = "ru.voicerooms.END_CURRENT_CALL";

  private static final int REQUEST_AUDIO = 31,
      REQUEST_NOTIFICATIONS = 32,
      REQUEST_FILE = 33,
      REQUEST_SAVE = 34;

  protected FrameLayout root;

  protected WebView web;

  protected SessionStore sessions;

  private ProgressBar progress;

  private View nativePanel;

  private PermissionRequest pendingAudio;

  private ValueCallback<Uri[]> pendingFiles;

  private byte[] pendingDownload;

  private String startUrl = TrustedOrigin.BASE;

  private ScriptHandler startScript;

  private boolean activeCall = false;

  private final BroadcastReceiver endCall =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
          if (ACTION_END.equals(i.getAction())) {
            endCurrentCall();
          }
        }
      };

  @Override
  public void onCreate(Bundle state) {

    super.onCreate(state);

    getWindow().setStatusBarColor(Color.rgb(23, 25, 28));
    getWindow().setNavigationBarColor(Color.rgb(23, 25, 28));
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

    sessions = new SessionStore(this);
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(23, 25, 28));
    root.setFitsSystemWindows(true);
    setContentView(root);

    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(23, 25, 28));
    root.addView(web, new FrameLayout.LayoutParams(-1, -1));

    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    FrameLayout.LayoutParams bar = new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP);
    root.addView(progress, bar);

    configureWebView();

    androidx.core.content.ContextCompat.registerReceiver(this, endCall, new IntentFilter(ACTION_END), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
    if (Build.VERSION.SDK_INT >= 33)
      getOnBackInvokedDispatcher()
          .registerOnBackInvokedCallback(
              android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);

    startUrl = trustedIntentUrl(getIntent());
    onReady();
  }

  protected void onReady() {
    openStart();
  }

  protected int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  protected void openStart() {
    installDocumentScript();
    openTrustedUrl(startUrl);
  }

  protected void openTrustedUrl(String url) {
    if (!TrustedOrigin.isTrusted(url)) return;
    clearNativePanel();
    web.setVisibility(View.VISIBLE);
    web.loadUrl(url);
  }

  protected String trustedIntentUrl(Intent intent) {
    String u = intent != null ? intent.getDataString() : null;
    return TrustedOrigin.isTrusted(u) ? u : TrustedOrigin.BASE;
  }

  private void configureWebView() {

    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSupportMultipleWindows(false);
    settings.setSafeBrowsingEnabled(true);
    settings.setUserAgentString(settings.getUserAgentString() + " VoiceRooms/1.2.0");

    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
      WebViewCompat.addWebMessageListener(
          web,
          "VoiceRoomsNativeHost",
          TrustedOrigin.allowedOrigins(),
          (view, message, origin, isMainFrame, reply) -> {
            if (!isMainFrame
                || !TrustedOrigin.isTrusted(origin.toString())
                || !TrustedOrigin.isTrusted(web.getUrl())) return;

            String raw = message.getData();
            if (raw == null || raw.length() > 15000000) return;

            try {
              JSONObject d = new JSONObject(raw);
              switch (d.getString("kind")) {
                case "call":
                  handleCallState(d.getBoolean("active"), d.getBoolean("microphone"));
                  break;

                case "session":
                  String token = d.getString("token");
                  if (token.isEmpty()) {
                    sessions.clear();
                    installDocumentScript();
                  } else if (SessionToken.isValid(token)) {
                    sessions.save(token);
                    installDocumentScript();
                  }
                  break;

                case "file":
                  saveFile(
                      d.getString("name"),
                      d.getString("base64"),
                      d.optString("mime", "application/octet-stream"));
                  break;

                default:
                  break;
              }
            } catch (Exception ignored) {
              Toast.makeText(
                      this, "Не удалось выполнить действие. Попробуйте ещё раз.", Toast.LENGTH_LONG)
                  .show();
            }
          });

    installDocumentScript();

    web.setWebChromeClient(
        new WebChromeClient() {

          @Override
          public void onProgressChanged(WebView view, int value) {
            progress.setProgress(value);
            progress.setVisibility(value < 100 ? View.VISIBLE : View.GONE);
          }

          @Override
          public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(
                () -> {
                  if (!TrustedOrigin.isTrusted(request.getOrigin().toString())
                      || !TrustedOrigin.isTrusted(web.getUrl())
                      || !Arrays.asList(request.getResources())
                          .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    request.deny();
                    return;
                  }

                  if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                      == PackageManager.PERMISSION_GRANTED)
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                  else {
                    if (pendingAudio != null) pendingAudio.deny();
                    pendingAudio = request;
                    requestPermissions(
                        new String[] {Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO);
                  }
                });
          }

          @Override
          public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingAudio == request) pendingAudio = null;
          }

          @Override
          public boolean onShowFileChooser(
              WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingFiles != null) pendingFiles.onReceiveValue(null);
            pendingFiles = callback;
            try {
              Intent intent = params.createIntent();
              intent.addCategory(Intent.CATEGORY_OPENABLE);
              startActivityForResult(intent, REQUEST_FILE);
            } catch (ActivityNotFoundException e) {
              pendingFiles = null;
              callback.onReceiveValue(null);
              Toast.makeText(
                      MainActivity.this,
                      "На устройстве нет приложения для выбора файлов.",
                      Toast.LENGTH_LONG)
                  .show();
            }
            return true;
          }
        });

    web.setWebViewClient(
        new WebViewClient() {

          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (TrustedOrigin.isTrusted(request.getUrl().toString())) return false;
            if (request.isForMainFrame()) openExternal(request.getUrl());
            return true;
          }

          @Override
          public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            clearNativePanel();
            progress.setVisibility(View.VISIBLE);
          }

          @Override
          public void onPageFinished(WebView view, String url) {
            progress.setVisibility(View.GONE);
          }

          @Override
          public void onReceivedError(
              WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showNetworkFailure(request.getUrl().toString());
          }

          @Override
          public void onReceivedHttpError(
              WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 400)
              showFailure(
                  "VoiceRooms временно недоступен",
                  "Попробуйте ещё раз чуть позже.",
                  () -> openTrustedUrl(request.getUrl().toString()));
          }

          @Override
          public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            showFailure(
                "Не удалось защитить соединение",
                "Проверьте дату и время на телефоне. Если они верны, попробуйте позже.",
                () -> openTrustedUrl(TrustedOrigin.BASE));
          }

          @Override
          public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            handleCallState(false, false);
            showFailure(
                "Страница закрыта системой",
                "Откройте VoiceRooms заново, чтобы продолжить.",
                () -> recreate());
            return true;
          }
        });

    web.setDownloadListener(
        (url, userAgent, disposition, mime, length) -> {
          if (url.startsWith("blob:") && TrustedOrigin.isTrusted(web.getUrl())) {

            String script =
                "(async()=>{try{const b=await(await fetch("
                    + JSONObject.quote(url)
                    + ")).blob();if(b.size>10485760)throw Error();const r=new"
                    + " FileReader();r.onload=()=>window.VoiceRoomsNative?.saveFile('Файл"
                    + " VoiceRooms',String(r.result).split(',')[1],b.type||'application/octet-stream');r.readAsDataURL(b);}catch{alert('Не"
                    + " удалось сохранить файл. Попросите отправить его заново.');}})()";

            web.evaluateJavascript(script, null);

          } else if (TrustedOrigin.isTrusted(url)) {

            try {
              String name = URLUtil.guessFileName(url, disposition, mime);
              DownloadManager.Request request =
                  new DownloadManager.Request(Uri.parse(url))
                      .setTitle(name)
                      .setNotificationVisibility(
                          DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
              if (Build.VERSION.SDK_INT >= 29)
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
              getSystemService(DownloadManager.class).enqueue(request);
              Toast.makeText(
                      this, "Загрузка началась. Файл появится в уведомлениях.", Toast.LENGTH_LONG)
                  .show();
            } catch (Exception e) {
              openExternal(Uri.parse(url));
            }

          } else openExternal(Uri.parse(url));
        });
  }

  protected void installDocumentScript() {

    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;

    if (startScript != null) startScript.remove();

    String token = sessions.read();
    String seed =
        token.isEmpty()
            ? ""
            : "sessionStorage.setItem('vr-session'," + JSONObject.quote(token) + ");";

    String script =
        seed
            + "if(window.VoiceRoomsNativeHost){window.VoiceRoomsNative=Object.freeze({callState:(active,microphone)=>VoiceRoomsNativeHost.postMessage(JSON.stringify({kind:'call',active:!!active,microphone:!!microphone})),saveSession:token=>VoiceRoomsNativeHost.postMessage(JSON.stringify({kind:'session',token})),saveFile:(name,base64,mime)=>VoiceRoomsNativeHost.postMessage(JSON.stringify({kind:'file',name,base64,mime}))});}";

    startScript =
        WebViewCompat.addDocumentStartJavaScript(web, script, TrustedOrigin.allowedOrigins());
  }

  protected void handleCallState(boolean active, boolean microphone) {

    activeCall = active;

    if (active) {
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      Intent service = new Intent(this, CallService.class).putExtra("microphone", microphone);
      try {
        startForegroundService(service);
      } catch (Exception e) {
        Toast.makeText(
                this,
                "Не удалось продолжить звонок в фоне. Оставьте приложение открытым.",
                Toast.LENGTH_LONG)
            .show();
      }
      if (Build.VERSION.SDK_INT >= 33
          && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
              != PackageManager.PERMISSION_GRANTED)
        requestPermissions(
            new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
    } else {
      getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      stopService(new Intent(this, CallService.class));
    }
  }

  protected void endCurrentCall() {
    if (TrustedOrigin.isTrusted(web.getUrl()))
      web.evaluateJavascript("window.dispatchEvent(new Event('voicerooms-native-end'))", null);
    handleCallState(false, false);
  }

  private void openExternal(Uri uri) {
    String scheme = uri.getScheme();
    if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return;
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, uri));
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, "Не найден браузер для открытия ссылки.", Toast.LENGTH_LONG).show();
    }
  }

  protected void clearNativePanel() {
    if (nativePanel != null) {
      root.removeView(nativePanel);
      nativePanel = null;
    }
  }

  protected void showNativePanel(View panel) {
    clearNativePanel();
    nativePanel = panel;
    web.setVisibility(View.GONE);
    root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    progress.setVisibility(View.GONE);
  }

  protected void showFailure(String title, String message, Runnable retry) {
    LinearLayout content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setGravity(Gravity.CENTER);
    content.setPadding(dp(28), dp(28), dp(28), dp(28));
    content.setBackgroundColor(Color.rgb(23, 25, 28));
    TextView h = new TextView(this);
    h.setText(title);
    h.setTextColor(Color.WHITE);
    h.setTextSize(25);
    h.setGravity(Gravity.CENTER);
    content.addView(h);
    TextView p = new TextView(this);
    p.setText(message);
    p.setTextColor(Color.rgb(180, 188, 198));
    p.setTextSize(16);
    p.setGravity(Gravity.CENTER);
    p.setPadding(0, dp(18), 0, dp(24));
    content.addView(p);
    Button button = new Button(this);
    button.setText("Попробовать снова");
    button.setAllCaps(false);
    button.setOnClickListener(v -> retry.run());
    content.addView(button);
    showNativePanel(content);
  }

  private void showNetworkFailure(String url) {
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    Network network = cm.getActiveNetwork();
    NetworkCapabilities caps = network == null ? null : cm.getNetworkCapabilities(network);
    boolean online =
        caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    showFailure(
        online ? "Не удалось открыть VoiceRooms" : "Нет подключения к интернету",
        online
            ? "Проверьте соединение и попробуйте ещё раз."
            : "Включите Wi-Fi или мобильный интернет и попробуйте снова.",
        () -> openTrustedUrl(url));
  }

  private void saveFile(String name, String base64, String mime) throws Exception {

    if (base64.length() > 14000000) throw new IllegalArgumentException();
    byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
    if (bytes.length > 10485760) throw new IllegalArgumentException();
    String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
    if (safe.isEmpty()) safe = "Файл VoiceRooms";
    if (safe.length() > 150) safe = safe.substring(0, 150);

    if (Build.VERSION.SDK_INT >= 29) {
      ContentValues values = new ContentValues();
      values.put(MediaStore.Downloads.DISPLAY_NAME, safe);
      values.put(MediaStore.Downloads.MIME_TYPE, mime);
      values.put(
          MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VoiceRooms");
      values.put(MediaStore.Downloads.IS_PENDING, 1);
      Uri saved = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
      if (saved == null) throw new IllegalStateException();
      try {
        try (OutputStream out = getContentResolver().openOutputStream(saved)) {
          if (out == null) throw new IllegalStateException();
          out.write(bytes);
        }
        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        getContentResolver().update(saved, values, null, null);
      } catch (Exception e) {
        getContentResolver().delete(saved, null, null);
        throw e;
      }
      Toast.makeText(this, "Файл сохранён в Загрузки → VoiceRooms.", Toast.LENGTH_LONG).show();
    } else {
      pendingDownload = bytes;
      Intent intent =
          new Intent(Intent.ACTION_CREATE_DOCUMENT)
              .addCategory(Intent.CATEGORY_OPENABLE)
              .setType(mime.isEmpty() ? "application/octet-stream" : mime)
              .putExtra(Intent.EXTRA_TITLE, safe);
      startActivityForResult(intent, REQUEST_SAVE);
    }
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
    super.onRequestPermissionsResult(request, permissions, grants);
    if (request == REQUEST_AUDIO && pendingAudio != null) {
      PermissionRequest p = pendingAudio;
      pendingAudio = null;
      if (grants.length > 0
          && grants[0] == PackageManager.PERMISSION_GRANTED
          && TrustedOrigin.isTrusted(web.getUrl())
          && TrustedOrigin.isTrusted(p.getOrigin().toString()))
        p.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
      else p.deny();
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == REQUEST_FILE && pendingFiles != null) {
      Uri[] files = WebChromeClient.FileChooserParams.parseResult(result, data);
      if (files != null)
        for (Uri u : files)
          if (!"content".equals(u.getScheme())) {
            files = null;
            break;
          }
      pendingFiles.onReceiveValue(files);
      pendingFiles = null;
    }
    if (request == REQUEST_SAVE && pendingDownload != null) {
      byte[] bytes = pendingDownload;
      pendingDownload = null;
      if (result == RESULT_OK && data != null && data.getData() != null) {
        try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
          if (out == null) throw new IllegalStateException();
          out.write(bytes);
          Toast.makeText(this, "Файл сохранён.", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
          Toast.makeText(this, "Не удалось сохранить файл. Попробуйте ещё раз.", Toast.LENGTH_LONG)
              .show();
        }
      }
    }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (intent.getData() == null || !TrustedOrigin.isTrusted(intent.getDataString())) return;
    String target = trustedIntentUrl(intent);
    if (activeCall && !target.equals(web.getUrl()))
      new AlertDialog.Builder(this)
          .setTitle("Открыть другую комнату?")
          .setMessage("Текущий разговор завершится.")
          .setNegativeButton("Остаться", null)
          .setPositiveButton(
              "Перейти",
              (d, w) -> {
                endCurrentCall();
                openTrustedUrl(target);
              })
          .show();
    else openTrustedUrl(target);
  }

  @Override
  public void onBackPressed() {
    handleBack();
  }

  private void handleBack() {
    if (activeCall)
      new AlertDialog.Builder(this)
          .setTitle("Выйти из разговора?")
          .setNegativeButton("Остаться", null)
          .setPositiveButton(
              "Выйти",
              (d, w) -> {
                endCurrentCall();
                finish();
              })
          .show();
    else if (web.canGoBack()) web.goBack();
    else finish();
  }

  @Override
  protected void onDestroy() {
    try {
      unregisterReceiver(endCall);
    } catch (Exception ignored) {
    }
    if (pendingAudio != null) pendingAudio.deny();
    if (pendingFiles != null) pendingFiles.onReceiveValue(null);
    stopService(new Intent(this, CallService.class));
    if (startScript != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) startScript.remove();
    web.stopLoading();
    web.destroy();
    super.onDestroy();
  }
}

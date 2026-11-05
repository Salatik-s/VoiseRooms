package ru.voicerooms;

import static org.junit.Assert.*;

import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.File;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeSmokeTest {

  private ActivityScenario<MainActivity> open(String path) {
    Intent intent =
        new Intent(
                InstrumentationRegistry.getInstrumentation().getTargetContext(), MainActivity.class)
            .setData(Uri.parse(TrustedOrigin.TEST_ORIGIN + path));
    return ActivityScenario.launch(intent);
  }

  private String evaluate(ActivityScenario<MainActivity> scenario, String js) throws Exception {
    AtomicReference<String> value = new AtomicReference<>("");
    CountDownLatch latch = new CountDownLatch(1);
    scenario.onActivity(
        activity ->
            activity.web.evaluateJavascript(
                js,
                result -> {
                  value.set(result);
                  latch.countDown();
                }));
    assertTrue("WebView callback missing", latch.await(8, TimeUnit.SECONDS));
    Object parsed = new JSONTokener(value.get()).nextValue();
    return String.valueOf(parsed);
  }

  private void waitFor(ActivityScenario<MainActivity> scenario, String js, String expected)
      throws Exception {
    long until = SystemClock.elapsedRealtime() + 30000;
    String last = "";
    do {
      last = evaluate(scenario, js);
      if (last.contains(expected)) return;
      SystemClock.sleep(250);
    } while (SystemClock.elapsedRealtime() < until);
    fail("Expected " + expected + " but got " + last);
  }

  private void webScreenshot(ActivityScenario<MainActivity> scenario, String name)
      throws Exception {
    CountDownLatch rendered = new CountDownLatch(1);
    scenario.onActivity(
        activity ->
            activity.web.postVisualStateCallback(
                0,
                new android.webkit.WebView.VisualStateCallback() {
                  @Override
                  public void onComplete(long requestId) {
                    activity
                        .web
                        .getViewTreeObserver()
                        .addOnDrawListener(
                            new android.view.ViewTreeObserver.OnDrawListener() {
                              private boolean posted;

                              @Override
                              public void onDraw() {
                                if (posted) return;
                                posted = true;
                                activity.web.post(
                                    () -> {
                                      activity.web.getViewTreeObserver().removeOnDrawListener(this);
                                      rendered.countDown();
                                    });
                              }
                            });
                    activity.web.invalidate();
                  }
                }));
    assertTrue("WebView did not render its updated frame", rendered.await(15, TimeUnit.SECONDS));
    screenshot(name);
  }

  private void tap(ActivityScenario<MainActivity> scenario, String selector) throws Exception {
    String rect =
        evaluate(
            scenario,
            "(()=>{const r=document.querySelector("
                + org.json.JSONObject.quote(selector)
                + ").getBoundingClientRect();return"
                + " JSON.stringify([r.left+r.width/2,r.top+r.height/2,innerWidth]);})()");
    org.json.JSONArray point = new org.json.JSONArray(rect);
    AtomicReference<int[]> position = new AtomicReference<>();
    scenario.onActivity(
        activity -> {
          int[] offset = new int[2];
          activity.web.getLocationOnScreen(offset);
          try {
            double scale = activity.web.getWidth() / point.getDouble(2);
            position.set(
                new int[] {
                  offset[0] + (int) Math.round(point.getDouble(0) * scale),
                  offset[1] + (int) Math.round(point.getDouble(1) * scale)
                });
          } catch (org.json.JSONException e) {
            throw new AssertionError(e);
          }
        });
    int[] xy = position.get();
    assertNotNull(xy);
    assertTrue(
        "Android tap was not injected",
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).click(xy[0], xy[1]));
  }

  private void screenshot(String name) throws Exception {
    UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    // DOM updates can precede the WebView compositor frame on a cold emulator.
    InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10000);
    SystemClock.sleep(500);
    File dir =
        InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null);
    assertNotNull(dir);
    File screenshot = new File(dir, name + ".png");
    assertTrue(device.takeScreenshot(screenshot));
    java.net.HttpURLConnection upload =
        (java.net.HttpURLConnection)
            new java.net.URL(TrustedOrigin.TEST_ORIGIN + "/__native_test_screenshot?name=" + name)
                .openConnection();
    try {
      upload.setRequestMethod("POST");
      upload.setDoOutput(true);
      upload.setConnectTimeout(10000);
      upload.setReadTimeout(10000);
      upload.setRequestProperty("Content-Type", "image/png");
      try (java.io.OutputStream stream = upload.getOutputStream()) {
        java.nio.file.Files.copy(screenshot.toPath(), stream);
      }
      assertEquals("Native screenshot was not collected", 201, upload.getResponseCode());
    } finally {
      upload.disconnect();
    }
  }

  @Test
  public void sessionStorageUsesAndroidKeystoreAndSupportsLogout() throws Exception {
    android.content.Context context =
        InstrumentationRegistry.getInstrumentation().getTargetContext();
    SessionStore store = new SessionStore(context);
    store.clear();
    String token = "eyJpZCI6LTF9.emulator-test-signature";
    store.save(token);
    assertEquals(token, store.read());
    assertFalse(
        context
            .getSharedPreferences("voice_session", android.content.Context.MODE_PRIVATE)
            .getAll()
            .toString()
            .contains(token));
    store.clear();
    assertEquals("", store.read());
  }

  @Test
  public void phoneCallUiLoadsAndRespondsWithoutMicrophonePermission() throws Exception {

    try (ActivityScenario<MainActivity> scenario = open("/?preview=call")) {

      waitFor(scenario, "document.body.innerText", "Вечерний разговор");
      webScreenshot(scenario, "android-call-phone");

      assertEquals(
          "true",
          evaluate(
              scenario,
              "Boolean(document.querySelector('button[aria-label=\"Выключить микрофон\"]'))"));

      tap(scenario, "button[aria-label=\"Выключить микрофон\"]");

      waitFor(
          scenario,
          "Boolean(document.querySelector('button[aria-label=\"Включить микрофон\"]'))",
          "true");

      tap(scenario, "button.chat-control");

      waitFor(scenario, "document.body.innerText", "Чат комнаты");
      webScreenshot(scenario, "android-chat-phone");

      assertEquals("false", evaluate(scenario, "document.documentElement.scrollWidth>innerWidth"));
      scenario.onActivity(MainActivity::onBackPressed);
      long destroyedBy = SystemClock.elapsedRealtime() + 10000;
      while (scenario.getState() != androidx.lifecycle.Lifecycle.State.DESTROYED
          && SystemClock.elapsedRealtime() < destroyedBy) {
        SystemClock.sleep(100);
      }
      assertEquals(androidx.lifecycle.Lifecycle.State.DESTROYED, scenario.getState());
    }
  }

  @Test
  public void nativeErrorIsRussianAndRetryRecovers() throws Exception {

    try (ActivityScenario<MainActivity> scenario = open("/?preview=call")) {
      waitFor(scenario, "document.body.innerText", "Вечерний разговор");
      scenario.onActivity(
          activity ->
              activity.openTrustedUrl(
                  TrustedOrigin.TEST_ORIGIN + "/__native_test_failure?preview=call"));

      UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
      boolean errorShown =
          device.wait(Until.hasObject(By.text("VoiceRooms временно недоступен")), 20000);
      screenshot("android-error-phone");
      assertTrue("The persistent HTTP 503 must show the Russian native error", errorShown);
      scenario.onActivity(MainActivity::onBackPressed);
      waitFor(scenario, "document.body.innerText", "Вечерний разговор");
      scenario.onActivity(
          activity -> assertEquals(android.view.View.VISIBLE, activity.web.getVisibility()));
      scenario.onActivity(
          activity ->
              activity.openTrustedUrl(
                  TrustedOrigin.TEST_ORIGIN + "/__native_test_failure?preview=call"));
      assertTrue(device.wait(Until.hasObject(By.text("VoiceRooms временно недоступен")), 20000));
      java.net.HttpURLConnection recover =
          (java.net.HttpURLConnection)
              new java.net.URL(TrustedOrigin.TEST_ORIGIN + "/__native_test_recover")
                  .openConnection();
      try {
        recover.setRequestMethod("POST");
        recover.setConnectTimeout(10000);
        recover.setReadTimeout(10000);
        assertEquals(200, recover.getResponseCode());
      } finally {
        recover.disconnect();
      }
      assertTrue(device.findObject(new UiSelector().text("Попробовать снова")).click());

      waitFor(scenario, "document.body.innerText", "Вечерний разговор");
    }
  }
}

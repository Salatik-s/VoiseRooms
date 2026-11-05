package ru.voicerooms;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.*;

public final class CallService extends Service {

  private static final String CHANNEL = "voicerooms-call";

  @Override
  public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel c =
        new NotificationChannel(CHANNEL, "Разговор VoiceRooms", NotificationManager.IMPORTANCE_LOW);
    c.setDescription("Позволяет продолжать разговор при свёрнутом приложении");
    nm.createNotificationChannel(c);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {

    if (intent != null && "end".equals(intent.getAction())) {
      sendBroadcast(new Intent(MainActivity.ACTION_END).setPackage(getPackageName()));
      stopSelf();
      return START_NOT_STICKY;
    }

    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());

    PendingIntent open =
        PendingIntent.getActivity(
            this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Intent end = new Intent(this, CallService.class).setAction("end");
    PendingIntent finish =
        PendingIntent.getService(
            this, 1, end, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Notification n =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_voice)
            .setContentTitle("VoiceRooms · разговор продолжается")
            .setContentText("Нажмите, чтобы вернуться в комнату")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, "Завершить разговор", finish).build())
            .build();

    boolean mic =
        intent != null
            && intent.getBooleanExtra("microphone", false)
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;

    try {
      if (Build.VERSION.SDK_INT >= 29) {
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        if (mic && Build.VERSION.SDK_INT >= 30) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        startForeground(24, n, type);
      } else startForeground(24, n);
    } catch (SecurityException e) {
      stopSelf();
    }

    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}

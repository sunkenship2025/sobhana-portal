package com.sobhana.display;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Best-effort auto-launch after the TV finishes booting. Reliable on most
 * Android TV devices/boxes; strict Google TV may block a background start, in
 * which case the app is still one click away on the TV home row.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)) {
            Intent launch = new Intent(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(launch);
            } catch (Exception ignored) {
                // Background-start blocked (some Google TV builds) — user opens it from home.
            }
        }
    }
}

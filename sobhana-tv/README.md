# Sobhana Display (Android TV kiosk)

A tiny fullscreen WebView app that locks an Android TV to the waiting-room
display URL. Free, no Fully Kiosk, no license.

**What it does**
- Fullscreen kiosk pointed at the screen's link (e.g. `https://www.sobhanaportal.com/display/chintal/op`).
- Plays the call chime with no tap (WebView audio autoplay is enabled).
- Keeps the screen awake, landscape, auto-reloads after Wi-Fi blips.
- Best-effort auto-launch on boot; always one click from the TV home row.
- First run asks for the link and remembers it. Press the remote **MENU** button to change it.

## Get the APK (no Android Studio needed)
1. In GitHub → **Actions** → **Build TV APK** → open the latest green run.
2. Download the **sobhana-display-apk** artifact and unzip → `app-debug.apk`.
   (Or push any change under `sobhana-tv/` to trigger a fresh build.)

## Install on the TV
1. On the TV: **Settings → Apps → Security → Unknown sources** → allow the app you'll install from.
2. Get the APK onto the TV — easiest with the **Downloader** app (put `app-debug.apk` on a link/Drive), or **Send files to TV** from your phone.
3. Install it → open **Sobhana Display** → paste the screen link → **Save & start**.

## Autostart
- **Classic Android TV / a box**: the boot receiver usually launches it on power-on. For a guaranteed result on a box, set it as the **Home app** (Settings → Apps → Default apps → Home).
- **Strict Google TV**: boot-launch may be blocked; it's then one click from the home row.

## Change the link later
Open the app and press the **MENU** button on the remote → edit the URL → Save.

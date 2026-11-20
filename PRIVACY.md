# Privacy Policy: Reasonable Chess

_Last updated: November 20, 2026_

Reasonable Chess is a free, open-source chess training app made by an individual developer.

## The short version

**The app collects nothing, sends nothing, and shares nothing.** It has no internet permission, so it physically cannot connect to the internet.

## Details

- **No data collection.** The app does not collect, store on a server, transmit, sell or share any personal or usage data. There are no accounts, ads, analytics, crash reporters or tracking libraries.
- **No network access.** The Android app does not request the `INTERNET` permission, or any other permission. Everything it needs, including the chess engine (Stockfish) and the human-move model (Maia-3), is built into the app and runs on your device. Android's built-in WebView Safe Browsing checks and usage metrics are turned off in the app.
- **What stays on your device.** Your settings, game statistics, play-style profile and practice drills are saved in the app's private storage on your phone so they're there next time. They never leave the device, and are excluded from Google cloud backups. Uninstalling the app, or clearing its storage in Android settings, deletes them. "Reset my stats" in the app's Style tab deletes them too.
- **Files you choose.** If you use the optional "Load .onnx file" setting, the file you pick is read on your device only.
- **Links.** Tapping the source-code, issue-tracker or email link in "About & privacy" opens your own browser or email app. That happens only when you tap, and those apps' own privacy policies apply.
- **Children.** The app is suitable for all ages and collects no data from anyone, including children.

## Verify it yourself

The full source code is public under the AGPL-3.0 license: https://github.com/ioctls/reasoning_chess. Every build is tested on an Android emulator with networking disabled.

## Changes

If this policy ever changes, the new version will be posted at this address with a new date.

## Contact

pthreadt@gmail.com

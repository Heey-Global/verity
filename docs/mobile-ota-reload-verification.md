# Verifying native OTA reload fixes

Unistyles 3.5.1 replaces the local iOS lifecycle patch with upstream runtime
ownership and stale-style guards. The 1.69.0 native release starts a new OTA
runtime line; 1.68.x installations must not receive its JavaScript bundles.
Existing installations need a new native binary to acquire the fix.

Before delivery, build the staging iOS profile from the updated lockfile and
confirm that native preparation succeeds. JavaScript tests and the extracted
C++ lifecycle harness do not replace an Objective-C++ build or device testing.

On a physical iPhone running the staging binary:

1. Confirm the installed native version is 1.69.0 and the update runtime is
   `staging-1.69.0`.
2. Download and apply a compatible staging OTA update while a themed screen is
   open. Check that the app restarts, renders styles, and remains responsive.
3. Repeat several OTA transitions, including after leaving the app open overnight
   and after backgrounding and foregrounding it. Exercise theme changes, swipe
   actions, image zoom, and animated screens after each reload.
4. Verify an older 1.68.x staging installation cannot select the new runtime's
   update. Verify cold launch and ordinary relaunch on the new binary too.
5. Inspect retained update diagnostics and iOS crash reports. Record the native
   build, update groups, device/OS, number of reloads, and any failures in release
   evidence before promotion.

The reported null access in `Parser::rebuildUnistyle` is consistent with a stale
style lookup during reload. The supplied crash report alone does not establish
its precise ordering; successful repeated device tests remain required.

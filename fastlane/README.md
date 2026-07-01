fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios status

```sh
[bundle exec] fastlane ios status
```

Check ASC connectivity + whether the app is registered / latest TestFlight build

### ios appstatus

```sh
[bundle exec] fastlane ios appstatus
```

Dump per-platform App Store version states (iOS + macOS)

### ios maccerts

```sh
[bundle exec] fastlane ios maccerts
```

Create + import MAS app & installer distribution certificates

### ios macprofile

```sh
[bundle exec] fastlane ios macprofile
```

Create + download the MAS provisioning profile

### ios masupload

```sh
[bundle exec] fastlane ios masupload
```

Upload the signed MAS .pkg to App Store Connect

### ios masreviewinfo

```sh
[bundle exec] fastlane ios masreviewinfo
```

Set macOS version + review contact (phone:"+60...")

### ios massubmit

```sh
[bundle exec] fastlane ios massubmit
```

Push macOS metadata + screenshots and submit for review

### ios register

```sh
[bundle exec] fastlane ios register
```

Create the App ID (and check the App Store Connect record)

### ios setversion

```sh
[bundle exec] fastlane ios setversion
```

Align the editable App Store version string (default 0.1.3, to match the build)

### ios diag

```sh
[bundle exec] fastlane ios diag
```

Diagnose what's blocking submission

### ios copyright

```sh
[bundle exec] fastlane ios copyright
```

Set the version copyright

### ios reviewinfo

```sh
[bundle exec] fastlane ios reviewinfo
```

Set App Review contact information

### ios contentrights

```sh
[bundle exec] fastlane ios contentrights
```

Set the Content Rights declaration (no third-party content)

### ios shots

```sh
[bundle exec] fastlane ios shots
```

Upload screenshots (fastlane/screenshots/<locale>) to App Store Connect

### ios build

```sh
[bundle exec] fastlane ios build
```

Build the App Store .ipa (Tauri, distribution signing)

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Upload the built .ipa to TestFlight

### ios release

```sh
[bundle exec] fastlane ios release
```

Submit the latest build to App Store review

### ios submit_now

```sh
[bundle exec] fastlane ios submit_now
```

Create the App Store version, set What's New, attach the build, and submit

----


## Android

### android status

```sh
[bundle exec] fastlane android status
```

Check Google Play track status (production/internal)

### android build

```sh
[bundle exec] fastlane android build
```

Build the signed release .aab (Tauri; needs release signing in build.gradle)

### android internal

```sh
[bundle exec] fastlane android internal
```

Upload the .aab to the internal track

### android listing

```sh
[bundle exec] fastlane android listing
```

Push the store listing text + images (no binary)

### android production

```sh
[bundle exec] fastlane android production
```

Upload the .aab to production (draft by default; status:completed to submit)

### android submit

```sh
[bundle exec] fastlane android submit
```

Submit the staged production draft for review (vc:1001 by default)

### android tracks

```sh
[bundle exec] fastlane android tracks
```

Dump all track releases + statuses (diagnostic)

### android golive

```sh
[bundle exec] fastlane android golive
```

Take the production draft live (completed + send for review)

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).

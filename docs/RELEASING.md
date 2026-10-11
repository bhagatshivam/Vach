# Releasing Vach

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the
release-signed APK, runs the guards, and publishes a GitHub Release with
`Vach.apk` attached. Branch pushes keep producing the debug APK artifact
(`.github/workflows/android-build.yml`) and never publish anything.

## One-time setup

### 1. Create the release keystore

`keytool` comes with any JDK. Android Studio bundles one, so if `keytool`
isn't on your PATH, use the bundled copy:

- macOS: `"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"`
- Windows: `& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe"`
- Linux: `<android-studio>/jbr/bin/keytool`

The keystore is PKCS12, which has **a single password**: when keytool asks
for a key password, it uses the store password. The `ANDROID_KEY_PASSWORD`
secret must therefore be **the same value** as `ANDROID_KEYSTORE_PASSWORD`;
the workflow fails with a clear message if they differ.

**Back up `vach-release.jks` and its password somewhere safe and never
commit it** (`.gitignore` already excludes `*.jks`, `*.keystore`, `*.p12`,
`*.pfx`). If it's lost, nobody can ever install an update over an
existing install; they'd have to uninstall (losing app data) and start over.

macOS / Linux (bash):

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore vach-release.jks -alias vach \
  -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore vach-release.jks -alias vach | grep 'SHA256:'
```

Windows (PowerShell):

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore vach-release.jks -alias vach `
  -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore vach-release.jks -alias vach | Select-String 'SHA256:'
```

The `SHA256:` line is the certificate fingerprint. It's public: it goes in
`.github/release-cert.sha256` and the README's Download section. Until it's
there, every release run fails with "fingerprint not set yet".

### 2. Add the four repository secrets

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `vach` |
| `ANDROID_KEY_PASSWORD` | the **same** password again |

With the GitHub CLI (`gh auth login` first). `gh secret set NAME` with no
value prompts for it, so passwords stay out of your shell history.

macOS / Linux (bash):

```bash
base64 < vach-release.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 -R bhagatshivam/Vach
gh secret set ANDROID_KEYSTORE_PASSWORD -R bhagatshivam/Vach
gh secret set ANDROID_KEY_ALIAS -R bhagatshivam/Vach --body vach
gh secret set ANDROID_KEY_PASSWORD -R bhagatshivam/Vach
```

Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path "vach-release.jks"))) | gh secret set ANDROID_KEYSTORE_BASE64 -R bhagatshivam/Vach
gh secret set ANDROID_KEYSTORE_PASSWORD -R bhagatshivam/Vach
gh secret set ANDROID_KEY_ALIAS -R bhagatshivam/Vach --body vach
gh secret set ANDROID_KEY_PASSWORD -R bhagatshivam/Vach
```

(`Resolve-Path` matters: `[IO.File]` resolves relative paths against the
process's starting directory, not PowerShell's current location.)

Without `gh`, use the web UI: repository → **Settings → Secrets and
variables → Actions → New repository secret**, once per secret. For the
keystore, copy the base64 text to the clipboard first and paste it as the
value:

- macOS: `base64 < vach-release.jks | tr -d '\n' | pbcopy`
- Linux: `base64 -w0 vach-release.jks` and copy the output
- Windows: `[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path "vach-release.jks"))) | Set-Clipboard`

### 3. Dry run

Actions → **Release** → **Run workflow**. It builds the release APK and
runs every guard except the tag-specific ones, uploads the result as a
`vach-release-apk` workflow artifact, and never publishes. It passes only
once the secrets and `.github/release-cert.sha256` are both set.

## Cutting a release

1. Bump `versionName` and `versionCode` in `android/app/build.gradle` on
   `main`. `versionCode` must be higher than at the previous tag.
2. Tag the merged commit on `main` with an **annotated** tag; its message
   becomes the release notes. The tag must be `v` + `versionName`.

```bash
git checkout main
git pull --ff-only
grep -E 'versionName|versionCode' android/app/build.gradle   # PowerShell: Select-String 'versionName|versionCode' android/app/build.gradle
git tag -a v1.9.0 -m "Vach 1.9.0" -m "What changed in this release."
git push origin v1.9.0
```

A tag with a suffix (`v2.0.0-rc1`, with `versionName "2.0.0-rc1"`) is
published as a **pre-release**. GitHub's `/releases/latest/download/Vach.apk`
link ignores pre-releases, so it keeps serving the last stable release.

## Deleting a bad release

Delete the release first, then the tag. Deleting only the tag turns the
release back into a draft that still holds the APK.

```bash
gh release delete v1.9.0 --cleanup-tag --yes -R bhagatshivam/Vach   # release + remote tag
git tag -d v1.9.0                                                    # local tag
```

Without `gh`: delete the release on the repository's Releases page, then run
`git push origin --delete v1.9.0` and `git tag -d v1.9.0`.

To re-release the same version after fixing something, delete as above,
merge the fix, and tag the new commit. If the bad APK was already installed
anywhere, bump `versionCode` instead so the fixed build installs as an update.

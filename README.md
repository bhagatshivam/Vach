# Vach (वाच)

> Marathi for "Read" (imperative of वाचणे) — a native Android app for reading a personal offline library of PDF and EPUB novels and light novels.

**Status:** Pre-build — planning complete, implementation not started
**Platform:** Android (native, sideloaded APK — no Play Store distribution for now)

---

## Why

Existing PDF/EPUB readers don't fit how I actually want to read:

- Paid readers (Adobe) aren't worth it for this use case.
- Free readers are ad-heavy.
- Open-source readers (tried KOReader) work but have rough UX — scroll behaviour, orientation/settings friction, no clean day/night toggle.

Vach is built exactly for how I actually read: smooth continuous scroll like a webnovel app, simple font/background customization, and full offline access to a folder of books already on my phone — no re-picking files, no internet, no ads, no bloat.

It also doubles as a demoable portfolio project: native Android, file-system integration, custom rendering pipeline.

---

## Goals

- A real, installed Android app that works fully offline (airplane mode on).
- Point the app at a folder on device once → persistent access to every PDF/EPUB there, no re-granting each session.
- Webnovel-style continuous smooth scroll (not paginated).
- Customizable font family, font size, line spacing, and background theme (warm/sepia, black/night, beige, custom color picker).
- Per-book reading progress saved automatically, fully on-device.
- Zero ads, zero telemetry, zero account/login.

### Non-Goals (for now)

- Play Store publishing
- iOS support
- Cloud sync across devices (Supabase available later, not a launch requirement)
- Annotation/highlighting/notes
- DRM-protected file support

---

## Why Native (not a PWA)

A web app was considered first but rejected: browsers can't get **persistent** access to a whole folder on Android — the user would have to re-approve file access repeatedly, defeating the "point it at my folder once" goal. Only a native app using Android's **Storage Access Framework (SAF)** can get durable, revocable-but-persistent folder permission. Since that's core to the point of the app, the whole project is native from the start.

---

## How It Works

### File access
- First launch prompts a SAF folder picker; permission is persisted (`takePersistableUriPermission`) across restarts and reboots.
- Scans the folder (and subfolders) for `.pdf` / `.epub` files to build the library.
- Detects newly added files on each app open — no re-picking.
- Reads directly from the granted folder; no copying into app-private storage.

### Rendering pipeline
| Source type | Approach |
|---|---|
| EPUB | Parsed directly (XHTML/CSS chapters) with a custom stylesheet — font, size, spacing, color |
| PDF, text-based | Embedded text extracted page-by-page, reflowed into the same continuous stream as EPUB |
| PDF, image-only pages (covers, illustrations) | Rendered as an image with a CSS-filter/color overlay for theme consistency — no font control possible |
| PDF, fully scanned | Same image-fallback path for the whole book (OCR out of scope) |

### Reading interface
- Continuous vertical scroll, tuned for smoothness — top priority, modeled on webnovel-app UX.
- Settings panel: font family (curated list), font size, line height, background theme.
- Themes: warm/sepia, black/night, beige, plus one custom slot.
- Reading position saved automatically per book, restored on reopen.

### Offline behavior
- Fully functional with no network connection, permanently, after install.
- No network calls anywhere in the reading flow.

---

## Tech Stack

- **Shell:** [Capacitor](https://capacitorjs.com/) — web-tech UI (React) in a native Android shell, with access to native APIs including SAF.
- **File access:** Capacitor filesystem/document-access plugin (or a small custom native plugin if needed).
- **PDF:** [pdf.js](https://mozilla.github.io/pdf.js/) for text extraction and rasterizing image-only pages.
- **EPUB:** Direct unzip + XHTML/OPF parsing (no external EPUB library expected to be necessary).
- **App state:** Local on-device storage only (SQLite via Capacitor plugin, or JSON/local storage) for library index, reading progress, and settings.
- **Build pipeline:** GitHub Actions builds the release/debug APK on push (Android SDK preinstalled on GitHub's runners); APK downloaded from build artifacts and sideloaded.

---

## Building & Running

### Get the APK
Every push triggers the `Android build` GitHub Actions workflow, which builds a debug APK and uploads it as a workflow artifact (`vach-debug-apk`) — download it from the Actions run summary and sideload it (enable "Install unknown apps" for whichever app you use to open the file).

### Build locally
Requires Node 20+ and a JDK 17+; the Android SDK itself is fetched by Gradle, so a machine with normal internet access (not a sandboxed one blocked from `dl.google.com`) is needed.

```bash
npm install
npm run build          # builds the web UI into dist/
npx cap sync android    # copies the web build into the native project
cd android
./gradlew assembleDebug # outputs app/build/outputs/apk/debug/app-debug.apk
```

### Verifying persistent folder permission
The whole point of Phase 1 is that folder access survives restarts and reboots without re-prompting. This can't be verified in CI (no way to drive the system folder-picker or simulate a reboot), so check it manually on a real device after installing the APK:

1. Open the app, tap **Choose library folder**, and grant access to a folder containing some `.pdf`/`.epub` files (in subfolders too, if you want to confirm recursive scanning).
2. Confirm the file list appears.
3. **Force-stop** the app (Settings → Apps → Vach → Force stop — not just backgrounding it) and reopen it. The file list should reappear immediately, with no picker prompt.
4. **Reboot the device** entirely and reopen the app. Same expectation: the list reappears with no re-prompt.
5. If you want to confirm the revocation path also works: go to Settings → Apps → Vach → Permissions (or "All files access"/storage access) and revoke folder access, then reopen the app — it should fall back to the "no folder selected" state instead of crashing.

---

## Known Constraints

- Font/text customization is impossible on scanned or image-only pages — no text to restyle. A hard limitation of the source material.
- No Play Store distribution without a $25 developer account + review — not planned; sideloaded APK only.
- Reflow quality will be worse on complex PDFs (multi-column academic papers, heavy footnotes/tables). The target library skews toward clean single-column novels/light novels, so this is a low-priority edge case.

---

## Roadmap

- [ ] **Phase 1 — Skeleton:** Capacitor scaffold, SAF folder-picker + persistent permission, GitHub Actions build pipeline producing an installable APK. *Success = a real app icon that lists files from a chosen folder, even with a placeholder reading UI.*
- [ ] **Phase 2 — Reading core:** EPUB reflow rendering, PDF text-extraction reflow, font/size/line-height/theme controls, smooth continuous scroll.
- [ ] **Phase 3 — Iteration & fallback path:** Image-page fallback with theme overlay, reading progress persistence, real-world testing against actual library files.
- [ ] **Phase 4 (optional):** Per-book settings override, in-book search, custom font uploads, cloud sync via Supabase.

---

## Success Criteria

- Installs and runs with zero network access, ever.
- Folder access survives an app restart and a device reboot without re-prompting.
- A real EPUB and a real clean-text PDF both render in continuous reflow with working font/size/theme controls.
- An image-only/illustration page displays correctly with a theme-consistent overlay instead of breaking the reading flow.
- Reading position is remembered correctly per book across sessions.

---

## Contributing / Commit Convention

This is a personal project built with the help of Claude Code. All commits and PRs are authored under **Shivam Bhagat**; Claude Code is credited as **co-author** where relevant, never as the primary commit author.

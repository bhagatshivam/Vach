package com.vach.reader

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

private const val TAG = "LibraryFolderPlugin"
// "docx" is the Word format (OOXML); the legacy binary ".doc" is deliberately not listed.
private val SUPPORTED_EXTENSIONS = setOf("pdf", "epub", "docx")

// Upper bound on one readChunk() call, enforced natively so a buggy or
// hostile caller can't ask for an arbitrarily large slice. 4 MiB because
// each call transiently holds the raw slice (4 MiB), its Base64 string
// (~5.3 MB) and the serialized bridge message (~5.6 MB, org.json escapes
// every '/' in Base64 as "\/") at once - roughly 15 MB, comfortably inside
// a 192 MB app heap even with a few calls in flight. Bigger slices don't buy
// throughput (the cost is dominated by the per-call fd open + bridge hop,
// which a 1 MiB slice already amortizes) but do raise GC pressure and the
// worst-case OOM exposure. The JS side normally asks for 1 MiB; this is
// only the hard ceiling.
private const val MAX_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Validates that [uri] is a content:// URI this app currently holds a
 * persisted *read* permission for - either an exact grant on this document
 * (a directly-picked file source) or a grant on an ancestor tree (a folder
 * source, where every document somewhere inside that tree is covered by
 * the one grant on the tree root). Returns a human-readable rejection
 * reason if the URI isn't usable, or null if it's safe to proceed.
 *
 * This is deliberately a single, small, top-level (not a Plugin method)
 * function so it can be unit-tested directly against a fake Context/Uri
 * later, without needing a running Capacitor bridge. It exists because
 * ContentResolver.openInputStream/DocumentFile will happily act on *any*
 * well-formed Uri they're given, including a file:// URI into this app's
 * own private storage (which never goes through the SAF permission-grant
 * system at all, since that system only governs content:// URIs) - without
 * this check, the only thing stopping readChunk/getSize/statFile/scanFolder from
 * reading anything the app process can read is that nothing is currently
 * asking them to.
 */
fun validateGrantedUri(context: Context, uri: Uri): String? {
    if (uri.scheme != "content") {
        return "Unsupported URI scheme: ${uri.scheme}"
    }

    val isGranted = context.contentResolver.persistedUriPermissions.any { perm ->
        perm.isReadPermission && (perm.uri == uri || isWithinGrantedTree(perm.uri, uri))
    }
    if (!isGranted) {
        return "This file is not covered by a granted permission"
    }
    return null
}

/**
 * True if [candidateUri] is the tree [grantedTreeUri] itself, or a document
 * somewhere inside it. Folder grants are SAF tree URIs; every document
 * inside one shares its authority and has a document id that is the tree's
 * own document id, or that id plus a "/"-prefixed suffix - checked with an
 * explicit boundary (not a bare string prefix) so a sibling folder whose
 * name happens to start with the same characters (e.g. a granted "Books"
 * tree and an ungranted sibling "BooksOther") never false-matches.
 */
private fun isWithinGrantedTree(grantedTreeUri: Uri, candidateUri: Uri): Boolean {
    if (grantedTreeUri.authority != candidateUri.authority) return false
    if (!DocumentsContract.isTreeUri(grantedTreeUri)) return false

    return try {
        val treeDocId = DocumentsContract.getTreeDocumentId(grantedTreeUri)
        val candidateDocId = DocumentsContract.getDocumentId(candidateUri)
        candidateDocId == treeDocId || candidateDocId.startsWith("$treeDocId/")
    } catch (e: Exception) {
        false
    }
}

@CapacitorPlugin(name = "LibraryFolder")
class LibraryFolderPlugin : Plugin() {

    override fun load() {
        Log.d(TAG, "load() - plugin instance created and attached to bridge")
    }

    @PluginMethod
    fun pickFolder(call: PluginCall) {
        Log.d(TAG, "pickFolder() called from JS")

        // FLAG_GRANT_PERSISTABLE_URI_PERMISSION belongs here, on the intent that
        // requests the grant — it tells the system this grant may later be made
        // permanent. It must NOT also be passed to takePersistableUriPermission()
        // below: that call's modeFlags only ever accepts READ/WRITE (the modes to
        // persist), never PERSISTABLE itself. The two calls read-only: request just
        // READ, no WRITE, since this app never writes to the library folder.
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        Log.d(TAG, "pickFolder() built intent action=${intent.action}")

        // Deliberately no resolveActivity() pre-check here: it returns null
        // not only when nothing can handle the intent, but also when *multiple*
        // apps can (Files, Drive, an OEM file manager, ...) and the user hasn't
        // set a default — which is the common case on a real device. Attempt
        // the launch directly and only treat an actual ActivityNotFoundException
        // as "nothing can handle this".
        try {
            Log.d(TAG, "pickFolder() calling startActivityForResult")
            startActivityForResult(call, intent, "handleFolderPicked")
            Log.d(TAG, "pickFolder() startActivityForResult returned (launcher.launch invoked)")
        } catch (e: ActivityNotFoundException) {
            Log.e(TAG, "pickFolder() no activity found for ACTION_OPEN_DOCUMENT_TREE", e)
            call.reject("No app available on this device to pick a folder", e)
        } catch (e: Exception) {
            Log.e(TAG, "pickFolder() threw while launching picker", e)
            call.reject("Failed to launch folder picker: ${e.message}", e)
        }
    }

    @ActivityCallback
    private fun handleFolderPicked(call: PluginCall?, result: ActivityResult) {
        Log.d(TAG, "handleFolderPicked() resultCode=${result.resultCode} data=${result.data}")

        if (call == null) {
            Log.e(TAG, "handleFolderPicked() no saved PluginCall to resolve/reject against")
            return
        }

        val uri = result.data?.data
        if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) {
            Log.w(TAG, "handleFolderPicked() cancelled or missing uri (resultCode=${result.resultCode})")
            call.reject("Folder selection was cancelled")
            return
        }

        Log.d(TAG, "handleFolderPicked() got uri=$uri, taking persistable permission")
        try {
            // modeFlags here must match the modes actually granted on this uri
            // (READ, since that's all pickFolder()'s launch intent above requested)
            // and must never include FLAG_GRANT_PERSISTABLE_URI_PERMISSION itself -
            // that flag has no meaning as a "mode" to persist, only as a request on
            // the launch intent. Passing it here throws
            // "Requested flags 0x41, but only 0x3 are allowed" - it did until this
            // fix, always, on every device, since 0x41 is never a valid mode.
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (e: Exception) {
            Log.e(TAG, "handleFolderPicked() takePersistableUriPermission failed", e)
            call.reject("Failed to persist folder access: ${e.message}", e)
            return
        }

        Log.d(TAG, "handleFolderPicked() permission persisted, resolving call")
        val ret = JSObject()
        ret.put("uri", uri.toString())
        call.resolve(ret)
    }

    @PluginMethod
    fun pickFiles(call: PluginCall) {
        Log.d(TAG, "pickFiles() called from JS")

        // Broad type + EXTRA_MIME_TYPES isn't used here: many file managers/cloud
        // providers don't tag .epub as application/epub+zip (nor .docx as
        // application/vnd.openxmlformats-officedocument.wordprocessingml.document),
        // so a strict MIME filter risks hiding legitimate files from the
        // picker. Accept anything
        // openable and filter by extension on the results instead, consistent
        // with how folder scanning already filters (see collectLibraryFiles).
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        Log.d(TAG, "pickFiles() built intent action=${intent.action}")

        try {
            Log.d(TAG, "pickFiles() calling startActivityForResult")
            startActivityForResult(call, intent, "handleFilesPicked")
            Log.d(TAG, "pickFiles() startActivityForResult returned")
        } catch (e: ActivityNotFoundException) {
            Log.e(TAG, "pickFiles() no activity found for ACTION_OPEN_DOCUMENT", e)
            call.reject("No app available on this device to pick files", e)
        } catch (e: Exception) {
            Log.e(TAG, "pickFiles() threw while launching picker", e)
            call.reject("Failed to launch file picker: ${e.message}", e)
        }
    }

    @ActivityCallback
    private fun handleFilesPicked(call: PluginCall?, result: ActivityResult) {
        Log.d(TAG, "handleFilesPicked() resultCode=${result.resultCode}")

        if (call == null) {
            Log.e(TAG, "handleFilesPicked() no saved PluginCall to resolve/reject against")
            return
        }

        if (result.resultCode != android.app.Activity.RESULT_OK) {
            Log.w(TAG, "handleFilesPicked() cancelled (resultCode=${result.resultCode})")
            call.reject("File selection was cancelled")
            return
        }

        // EXTRA_ALLOW_MULTIPLE results land in clipData when more than one file
        // was picked, but clipData can be null even with multi-select enabled if
        // the user picked exactly one - that single result comes back in data
        // instead. Both paths need handling.
        val data = result.data
        val uris = mutableListOf<Uri>()
        val clipData = data?.clipData
        if (clipData != null) {
            for (i in 0 until clipData.itemCount) {
                clipData.getItemAt(i)?.uri?.let { uris.add(it) }
            }
        } else {
            data?.data?.let { uris.add(it) }
        }
        Log.d(TAG, "handleFilesPicked() picked ${uris.size} uri(s)")

        val accepted = mutableListOf<String>()
        for (uri in uris) {
            val name = DocumentFile.fromSingleUri(context, uri)?.name
            if (name == null) {
                Log.w(TAG, "handleFilesPicked() could not resolve name for $uri, skipping")
                continue
            }

            val extension = name.substringAfterLast('.', "").lowercase()
            if (extension !in SUPPORTED_EXTENSIONS) {
                Log.d(TAG, "handleFilesPicked() skipping unsupported file: $name")
                continue
            }

            try {
                // Same READ-only pattern as handleFolderPicked() above, and for the
                // same reason: PERSISTABLE is never a valid modeFlags bit here.
                context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                accepted.add(uri.toString())
            } catch (e: Exception) {
                Log.e(TAG, "handleFilesPicked() takePersistableUriPermission failed for $uri", e)
            }
        }
        Log.d(TAG, "handleFilesPicked() accepted ${accepted.size} of ${uris.size} picked file(s)")

        val ret = JSObject()
        ret.put("uris", JSArray(accepted))
        call.resolve(ret)
    }

    @PluginMethod
    fun statFile(call: PluginCall) {
        val uriString = call.getString("uri")
        Log.d(TAG, "statFile() uri=$uriString")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val uri = Uri.parse(uriString)
        val validationError = validateGrantedUri(context, uri)
        if (validationError != null) {
            Log.e(TAG, "statFile() rejected $uriString: $validationError")
            call.reject(validationError)
            return
        }

        try {
            val doc = DocumentFile.fromSingleUri(context, uri)
            val name = doc?.name
            if (doc == null || name == null || !doc.exists()) {
                Log.e(TAG, "statFile() file no longer accessible: $uriString")
                call.reject("File is no longer accessible")
                return
            }

            val file = JSObject()
            file.put("name", name)
            file.put("uri", uri.toString())
            file.put("path", name)
            file.put("size", doc.length())
            Log.d(TAG, "statFile() resolved name=$name size=${doc.length()}")

            val ret = JSObject()
            ret.put("file", file)
            call.resolve(ret)
        } catch (t: Throwable) {
            Log.e(TAG, "statFile() failed for $uriString", t)
            call.reject("File is no longer accessible")
        }
    }

    /**
     * Reads a non-negative integer parameter. Capacitor's PluginCall.getLong
     * only returns a value when org.json happened to parse the number as a
     * Long; a JS number like 1048576 arrives as an Integer and getLong would
     * silently return null, so the raw value is inspected instead. Doubles
     * are accepted only if they are whole numbers (JS has one number type).
     */
    private fun readNonNegativeLong(call: PluginCall, name: String): Long? {
        val raw = call.data.opt(name)
        val value: Long = when (raw) {
            is Int -> raw.toLong()
            is Long -> raw
            is Double -> if (raw == Math.floor(raw) && !raw.isInfinite() && raw < 9.007199254740992E15) raw.toLong() else return null
            else -> return null
        }
        return if (value >= 0) value else null
    }

    @PluginMethod
    fun getSize(call: PluginCall) {
        val uriString = call.getString("uri")
        Log.d(TAG, "getSize() uri=$uriString")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val uri = Uri.parse(uriString)
        val validationError = validateGrantedUri(context, uri)
        if (validationError != null) {
            Log.e(TAG, "getSize() rejected $uriString: $validationError")
            call.reject(validationError)
            return
        }

        try {
            // statSize is the real size of the opened descriptor (-1 when the
            // provider can't say); DocumentFile.length() is only a fallback,
            // since it reports 0 for "unknown" as well as for an empty file.
            var size = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
            if (size < 0) {
                size = DocumentFile.fromSingleUri(context, uri)?.length() ?: 0L
                if (size <= 0) {
                    Log.e(TAG, "getSize() could not determine size for $uriString")
                    call.reject("Could not determine the size of this file")
                    return
                }
            }
            val ret = JSObject()
            ret.put("size", size)
            call.resolve(ret)
        } catch (t: Throwable) {
            Log.e(TAG, "getSize() failed for $uriString", t)
            call.reject("Failed to read file size: ${t.message}")
        }
    }

    /**
     * Returns one slice of a file, [offset, offset + length), as Base64. The
     * slice is read with a positioned read (pread) on a descriptor opened for
     * just this call - the file is never read from the start, so cost is
     * proportional to the slice, not to the offset or the file size. Fewer
     * bytes than requested come back only at end of file (a read at or past
     * the end returns an empty slice).
     */
    @PluginMethod
    fun readChunk(call: PluginCall) {
        val uriString = call.getString("uri")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val offset = readNonNegativeLong(call, "offset")
        if (offset == null) {
            call.reject("Invalid 'offset': must be a non-negative integer")
            return
        }
        val requested = readNonNegativeLong(call, "length")
        if (requested == null || requested < 1 || requested > MAX_CHUNK_BYTES) {
            call.reject("Invalid 'length': must be an integer from 1 to $MAX_CHUNK_BYTES")
            return
        }
        val length = requested.toInt()

        val uri = Uri.parse(uriString)
        val validationError = validateGrantedUri(context, uri)
        if (validationError != null) {
            Log.e(TAG, "readChunk() rejected $uriString: $validationError")
            call.reject(validationError)
            return
        }

        try {
            val pfd = context.contentResolver.openFileDescriptor(uri, "r")
            if (pfd == null) {
                Log.e(TAG, "readChunk() openFileDescriptor returned null for $uriString")
                call.reject("Could not open file for reading")
                return
            }
            val buffer = ByteArray(length)
            var filled = 0
            pfd.use {
                while (filled < length) {
                    val n = Os.pread(it.fileDescriptor, buffer, filled, length - filled, offset + filled)
                    if (n <= 0) break // end of file
                    filled += n
                }
            }

            val ret = JSObject()
            ret.put("base64", Base64.encodeToString(buffer, 0, filled, Base64.NO_WRAP))
            ret.put("length", filled)
            call.resolve(ret)
        } catch (e: ErrnoException) {
            Log.e(TAG, "readChunk() pread failed for $uriString (errno ${e.errno})", e)
            if (e.errno == OsConstants.ESPIPE) {
                call.reject("This file's storage doesn't support random access, so it can't be opened")
            } else {
                call.reject("Failed to read file: ${e.message}")
            }
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "readChunk() out of memory reading $uriString", e)
            call.reject("Out of memory while reading this file")
        } catch (t: Throwable) {
            Log.e(TAG, "readChunk() failed for $uriString", t)
            call.reject("Failed to read file: ${t.message}")
        }
    }

    @PluginMethod
    fun hasPersistedPermission(call: PluginCall) {
        val uriString = call.getString("uri")
        Log.d(TAG, "hasPersistedPermission() uri=$uriString")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val granted = context.contentResolver.persistedUriPermissions.any {
            it.uri.toString() == uriString && it.isReadPermission
        }
        Log.d(TAG, "hasPersistedPermission() granted=$granted")

        val ret = JSObject()
        ret.put("granted", granted)
        call.resolve(ret)
    }

    @PluginMethod
    fun scanFolder(call: PluginCall) {
        val uriString = call.getString("uri")
        Log.d(TAG, "scanFolder() uri=$uriString")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val treeUri = Uri.parse(uriString)
        val validationError = validateGrantedUri(context, treeUri)
        if (validationError != null) {
            Log.e(TAG, "scanFolder() rejected $uriString: $validationError")
            call.reject(validationError)
            return
        }

        try {
            // DocumentFile.fromTreeUri throws IllegalArgumentException for a
            // Uri that isn't actually a tree Uri (malformed input) - this
            // method's whole body needs to tolerate that rather than crash,
            // same as any other unexpected provider failure here.
            val root = DocumentFile.fromTreeUri(context, treeUri)
            if (root == null || !root.isDirectory) {
                Log.e(TAG, "scanFolder() folder no longer accessible: $uriString")
                call.reject("Folder is no longer accessible")
                return
            }

            val results = JSArray()
            collectLibraryFiles(root, "", results)
            Log.d(TAG, "scanFolder() found ${results.length()} matching file(s)")

            val ret = JSObject()
            ret.put("name", root.name ?: uriString)
            ret.put("files", results)
            call.resolve(ret)
        } catch (t: Throwable) {
            Log.e(TAG, "scanFolder() failed for $uriString", t)
            call.reject("Folder is no longer accessible")
        }
    }

    private fun collectLibraryFiles(dir: DocumentFile, relativePath: String, results: JSArray) {
        for (entry in dir.listFiles()) {
            val name = entry.name ?: continue
            val entryPath = if (relativePath.isEmpty()) name else "$relativePath/$name"

            if (entry.isDirectory) {
                collectLibraryFiles(entry, entryPath, results)
                continue
            }

            val extension = name.substringAfterLast('.', "").lowercase()
            if (extension !in SUPPORTED_EXTENSIONS) continue

            val file = JSObject()
            file.put("name", name)
            file.put("uri", entry.uri.toString())
            file.put("path", entryPath)
            file.put("size", entry.length())
            results.put(file)
        }
    }
}

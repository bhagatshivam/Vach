package com.vach.reader

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
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
private val SUPPORTED_EXTENSIONS = setOf("pdf", "epub")

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
        ret.put("files", results)
        call.resolve(ret)
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

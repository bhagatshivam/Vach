package com.vach.reader

import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

private val SUPPORTED_EXTENSIONS = setOf("pdf", "epub")

@CapacitorPlugin(name = "LibraryFolder")
class LibraryFolderPlugin : Plugin() {

    @PluginMethod
    fun pickFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "handleFolderPicked")
    }

    @ActivityCallback
    private fun handleFolderPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return

        val uri = result.data?.data
        if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) {
            call.reject("Folder selection was cancelled")
            return
        }

        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )

        val ret = JSObject()
        ret.put("uri", uri.toString())
        call.resolve(ret)
    }

    @PluginMethod
    fun hasPersistedPermission(call: PluginCall) {
        val uriString = call.getString("uri")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val granted = context.contentResolver.persistedUriPermissions.any {
            it.uri.toString() == uriString && it.isReadPermission
        }

        val ret = JSObject()
        ret.put("granted", granted)
        call.resolve(ret)
    }

    @PluginMethod
    fun scanFolder(call: PluginCall) {
        val uriString = call.getString("uri")
        if (uriString == null) {
            call.reject("Missing 'uri' parameter")
            return
        }

        val treeUri = Uri.parse(uriString)
        val root = DocumentFile.fromTreeUri(context, treeUri)
        if (root == null || !root.isDirectory) {
            call.reject("Folder is no longer accessible")
            return
        }

        val results = JSArray()
        collectLibraryFiles(root, "", results)

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

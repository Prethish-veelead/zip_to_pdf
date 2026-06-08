package com.zipforge.app

import android.graphics.BitmapFactory
import android.graphics.pdf.PdfDocument
import android.os.Environment
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream

@CapacitorPlugin(name = "NativePdfGenerator")
class NativePdfGenerator : Plugin() {

    @PluginMethod
    fun generatePdf(call: PluginCall) {
        val images = call.getArray("images")
        val outputName = call.getString("outputName")
        val outputFolder = call.getString("outputFolder")

        if (images == null || images.length() == 0 || outputName == null || outputFolder == null) {
            call.reject("Missing required parameters: images, outputName, or outputFolder")
            return
        }

        Thread {
            try {
                val pdfDocument = PdfDocument()

                for (i in 0 until images.length()) {
                    val imagePath = images.getString(i)
                    val bitmap = BitmapFactory.decodeFile(imagePath)

                    if (bitmap != null) {
                        val pageInfo = PdfDocument.PageInfo.Builder(bitmap.width, bitmap.height, i + 1).create()
                        val page = pdfDocument.startPage(pageInfo)

                        val canvas = page.canvas
                        canvas.drawBitmap(bitmap, 0f, 0f, null)

                        pdfDocument.finishPage(page)
                        bitmap.recycle() // INSTANTLY FREE MEMORY
                    }
                }

                // Prepare output directory
                val publicDocsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
                val appDir = File(publicDocsDir, outputFolder)
                if (!appDir.exists()) {
                    appDir.mkdirs()
                }

                // File path
                val finalFileName = if (outputName.endsWith(".pdf")) outputName else "$outputName.pdf"
                val outputFile = File(appDir, finalFileName)

                val fileOutputStream = FileOutputStream(outputFile)
                pdfDocument.writeTo(fileOutputStream)
                pdfDocument.close()
                fileOutputStream.close()

                val ret = JSObject()
                // Return relative path for Capacitor plugins, and absolute path for UI
                ret.put("path", "$outputFolder/$finalFileName")
                ret.put("absolutePath", outputFile.absolutePath)
                
                call.resolve(ret)

            } catch (e: Exception) {
                e.printStackTrace()
                call.reject("Failed to generate PDF: " + e.message)
            }
        }.start()
    }
}

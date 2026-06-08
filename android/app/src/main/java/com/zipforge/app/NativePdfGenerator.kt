package com.zipforge.app

import android.graphics.BitmapFactory
import android.os.Environment
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.itextpdf.io.image.ImageDataFactory
import com.itextpdf.kernel.geom.PageSize
import com.itextpdf.kernel.geom.Rectangle
import com.itextpdf.kernel.pdf.PdfDocument
import com.itextpdf.kernel.pdf.PdfWriter
import com.itextpdf.kernel.pdf.canvas.PdfCanvas
import com.itextpdf.kernel.pdf.xobject.PdfImageXObject
import java.io.File
import java.io.FileOutputStream

@CapacitorPlugin(name = "NativePdfGenerator")
class NativePdfGenerator : Plugin() {

    @PluginMethod
    fun generatePdf(call: PluginCall) {
        val images      = call.getArray("images")
        val outputName  = call.getString("outputName")
        val outputFolder = call.getString("outputFolder")
        val pageSizeMode = call.getString("pageSize") ?: "smart"

        if (images == null || images.length() == 0 || outputName == null || outputFolder == null) {
            call.reject("Missing required parameters: images, outputName, or outputFolder")
            return
        }

        Thread {
            try {
                val imagePaths = (0 until images.length()).mapNotNull { images.getString(it) }

                val publicDocsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
                val appDir = File(publicDocsDir, outputFolder)
                if (!appDir.exists()) appDir.mkdirs()

                val finalFileName = if (outputName.endsWith(".pdf")) outputName else "$outputName.pdf"
                val outputFile = File(appDir, finalFileName)

                val pdfDoc = PdfDocument(PdfWriter(FileOutputStream(outputFile)))

                // Smart mode: find the most common image dimension to use as page size
                val smartSize: Pair<Float, Float>? = if (pageSizeMode == "smart") {
                    computeDominantSizePx(imagePaths)
                } else null

                for (imagePath in imagePaths) {
                    if (!File(imagePath).exists()) continue

                    // iText reads JPEG bytes as-is (DCTDecode) — no decompression, no size explosion
                    val imageData = ImageDataFactory.create(imagePath)
                    val xObject  = PdfImageXObject(imageData)

                    val imgW = imageData.width.toFloat()   // pixels
                    val imgH = imageData.height.toFloat()  // pixels

                    val pageSize = when (pageSizeMode) {
                        "a4"    -> PageSize.A4
                        "smart" -> if (smartSize != null) PageSize(smartSize.first, smartSize.second)
                                   else PageSize(imgW, imgH)
                        else    -> PageSize(imgW, imgH)    // original: 1px = 1pt
                    }

                    val page   = pdfDoc.addNewPage(pageSize)
                    val canvas = PdfCanvas(page)

                    val pageW = pageSize.width
                    val pageH = pageSize.height

                    if (pageSizeMode == "original") {
                        // Image fills the page exactly at native pixel dimensions
                        canvas.addXObjectFittedIntoRectangle(xObject, Rectangle(0f, 0f, pageW, pageH))
                    } else {
                        // Scale to fit, letterbox/pillarbox, center on page
                        val scale = minOf(pageW / imgW, pageH / imgH)
                        val drawW = imgW * scale
                        val drawH = imgH * scale
                        val x = (pageW - drawW) / 2f
                        val y = (pageH - drawH) / 2f
                        canvas.addXObjectFittedIntoRectangle(xObject, Rectangle(x, y, drawW, drawH))
                    }

                    canvas.release()
                }

                pdfDoc.close()

                val ret = JSObject()
                ret.put("path", "$outputFolder/$finalFileName")
                ret.put("absolutePath", outputFile.absolutePath)
                call.resolve(ret)

            } catch (e: Exception) {
                e.printStackTrace()
                call.reject("Failed to generate PDF: ${e.message}")
            }
        }.start()
    }

    // Use BitmapFactory with inJustDecodeBounds=true to read only headers (fast, no RAM)
    private fun computeDominantSizePx(imagePaths: List<String>): Pair<Float, Float>? {
        val sizeCounts = mutableMapOf<Pair<Int, Int>, Int>()
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        for (path in imagePaths) {
            BitmapFactory.decodeFile(path, opts)
            if (opts.outWidth > 0 && opts.outHeight > 0) {
                val key = Pair(opts.outWidth, opts.outHeight)
                sizeCounts[key] = (sizeCounts[key] ?: 0) + 1
            }
        }
        if (sizeCounts.isEmpty()) return null
        val dominant = sizeCounts.maxByOrNull { it.value }?.key ?: return null
        return Pair(dominant.first.toFloat(), dominant.second.toFloat())
    }
}

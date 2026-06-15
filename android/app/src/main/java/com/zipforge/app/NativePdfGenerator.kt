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
import com.itextpdf.kernel.pdf.PdfReader
import com.itextpdf.kernel.pdf.PdfWriter
import com.itextpdf.kernel.utils.PdfMerger
import com.itextpdf.kernel.pdf.canvas.PdfCanvas
import com.itextpdf.kernel.pdf.xobject.PdfImageXObject
import java.io.File
import java.io.FileOutputStream

@CapacitorPlugin(name = "NativePdfGenerator")
class NativePdfGenerator : Plugin() {

    private data class SmartSizes(
        val portrait:  Pair<Float, Float>?,
        val landscape: Pair<Float, Float>?
    )

    @PluginMethod
    fun generatePdf(call: PluginCall) {
        val images       = call.getArray("images")
        val outputName   = call.getString("outputName")
        val outputFolder = call.getString("outputFolder")
        val pageSizeMode = call.getString("pageSize") ?: "smart"

        if (images == null || images.length() == 0 || outputName == null || outputFolder == null) {
            call.reject("Missing required parameters: images, outputName, or outputFolder")
            return
        }

        Thread {
            try {
                val imagePaths = (0 until images.length()).mapNotNull { images.getString(it) }

                val cacheDir = context.cacheDir
                val appDir = File(cacheDir, "ZipForgeCache")
                if (!appDir.exists()) appDir.mkdirs()

                val finalFileName = if (outputName.endsWith(".pdf")) outputName else "$outputName.pdf"
                val outputFile = File(appDir, finalFileName)

                val pdfDoc = PdfDocument(PdfWriter(FileOutputStream(outputFile)))
                pdfDoc.setFlushUnusedObjects(true)

                // Smart mode: compute dominant size separately for portrait and landscape groups
                val smartSizes: SmartSizes? = if (pageSizeMode == "smart") {
                    computeSmartSizes(imagePaths)
                } else null

                val uniformSize: Pair<Float, Float>? = if (pageSizeMode == "uniform") {
                    computeUniformSize(imagePaths)
                } else null

                for (imagePath in imagePaths) {
                    if (!File(imagePath).exists()) continue

                    // BEST OF BOTH WORLDS:
                    // 1. iText natively handles JPEGs/PNGs without EVER unpacking them into massive 4MB-8MB Android Bitmaps.
                    // 2. If it fails (e.g. WebP), we fallback to the user's explicit RGB_565 memory-saving hack.
                    val imageData = try {
                        ImageDataFactory.create(imagePath)
                    } catch (e: Exception) {
                        val optsDec = BitmapFactory.Options()
                        optsDec.inPreferredConfig = android.graphics.Bitmap.Config.RGB_565
                        val bitmap = BitmapFactory.decodeFile(imagePath, optsDec)
                            ?: continue // Skip unreadable images

                        val stream = java.io.ByteArrayOutputStream()
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, stream)
                        bitmap.recycle() // Free native heap before copying bytes
                        val bytes = stream.toByteArray()
                        stream.reset()   // Free stream's internal buffer
                        ImageDataFactory.create(bytes)
                    }
                    
                    val xObject  = PdfImageXObject(imageData)

                    // Get dimensions safely without loading pixels into RAM
                    val optsDims = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(imagePath, optsDims)

                    val imgW        = optsDims.outWidth.toFloat()
                    val imgH        = optsDims.outHeight.toFloat()
                    val isLandscape = imgW > imgH

                    val pageSize = when (pageSizeMode) {
                        "a4"      -> PageSize.A4
                        "smart"   -> {
                            val target = if (isLandscape) smartSizes?.landscape else smartSizes?.portrait
                            if (target != null) PageSize(target.first, target.second) else PageSize(imgW, imgH)
                        }
                        "uniform" -> {
                            if (uniformSize != null) PageSize(uniformSize.first, uniformSize.second) else PageSize(imgW, imgH)
                        }
                        "tight"   -> {
                            val maxW = PageSize.A4.width
                            val maxH = PageSize.A4.height
                            val rawScale = minOf(maxW / imgW, maxH / imgH)
                            val scale = minOf(rawScale, 1.0f)
                            PageSize(imgW * scale, imgH * scale)
                        }
                        else      -> PageSize(imgW, imgH)    // original: 1px = 1pt
                    }

                    val page   = pdfDoc.addNewPage(pageSize)
                    val canvas = PdfCanvas(page)

                    val pageW = pageSize.width
                    val pageH = pageSize.height

                    if (pageSizeMode == "original" || pageSizeMode == "tight") {
                        canvas.addXObjectFittedIntoRectangle(xObject, Rectangle(0f, 0f, pageW, pageH))
                    } else {
                        val rawScale = minOf(pageW / imgW, pageH / imgH)
                        // Smart mode: never scale up — small images stay centered at native size
                        // Uniform mode: upscaling is allowed, so we just use rawScale
                        val scale = if (pageSizeMode == "smart") minOf(rawScale, 1.0f) else rawScale
                        val drawW = imgW * scale
                        val drawH = imgH * scale
                        val x = (pageW - drawW) / 2f
                        val y = (pageH - drawH) / 2f
                        canvas.addXObjectFittedIntoRectangle(xObject, Rectangle(x, y, drawW, drawH))
                    }

                    canvas.release()
                    System.gc()
                }

                pdfDoc.close()

                val ret = JSObject()
                ret.put("path", "ZipForgeCache/$finalFileName")
                ret.put("absolutePath", outputFile.absolutePath)
                call.resolve(ret)

            } catch (e: Exception) {
                e.printStackTrace()
                call.reject("Failed to generate PDF: ${e.message}")
            }
        }.start()
    }

    @PluginMethod
    fun mergePdfs(call: PluginCall) {
        val chunks       = call.getArray("chunks")
        val outputName   = call.getString("outputName")
        val outputFolder = call.getString("outputFolder")

        if (chunks == null || chunks.length() == 0 || outputName == null || outputFolder == null) {
            call.reject("Missing required parameters: chunks, outputName, or outputFolder")
            return
        }

        Thread {
            try {
                val cacheDir = context.cacheDir
                val appDir = File(cacheDir, "ZipForgeCache")
                if (!appDir.exists()) appDir.mkdirs()

                val finalFileName = if (outputName.endsWith(".pdf")) outputName else "$outputName.pdf"
                val outputFile = File(appDir, finalFileName)

                val finalPdfDoc = PdfDocument(PdfWriter(FileOutputStream(outputFile)))
                finalPdfDoc.setFlushUnusedObjects(true) // CRITICAL: Force merger to stream to disk
                val merger = PdfMerger(finalPdfDoc)

                for (i in 0 until chunks.length()) {
                    val chunkPath = chunks.getString(i) ?: continue
                    val chunkFile = File(cacheDir, chunkPath)
                    if (!chunkFile.exists()) continue

                    val chunkPdfDoc = PdfDocument(PdfReader(chunkFile))
                    merger.merge(chunkPdfDoc, 1, chunkPdfDoc.numberOfPages)
                    // Flush merged objects to disk before closing; without this iText
                    // accumulates all 19 chunks' image XObjects in JVM heap → OOM crash.
                    finalPdfDoc.flushCopiedObjects(chunkPdfDoc)
                    chunkPdfDoc.close()
                    chunkFile.delete()
                    System.gc()
                }

                finalPdfDoc.close()

                val ret = JSObject()
                ret.put("path", "ZipForgeCache/$finalFileName")
                ret.put("absolutePath", outputFile.absolutePath)
                call.resolve(ret)

            } catch (e: Exception) {
                e.printStackTrace()
                call.reject("Failed to merge PDFs: ${e.message}")
            }
        }.start()
    }

    // Separate portrait and landscape images, find dominant size for each group independently
    private fun computeSmartSizes(imagePaths: List<String>): SmartSizes {
        val portraitCounts  = mutableMapOf<Pair<Int, Int>, Int>()
        val landscapeCounts = mutableMapOf<Pair<Int, Int>, Int>()
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }

        for (path in imagePaths) {
            BitmapFactory.decodeFile(path, opts)
            if (opts.outWidth > 0 && opts.outHeight > 0) {
                val key = Pair(opts.outWidth, opts.outHeight)
                if (opts.outWidth <= opts.outHeight) {
                    portraitCounts[key]  = (portraitCounts[key]  ?: 0) + 1
                } else {
                    landscapeCounts[key] = (landscapeCounts[key] ?: 0) + 1
                }
            }
        }

        val dominantPortrait  = portraitCounts.maxByOrNull  { it.value }?.key
        val dominantLandscape = landscapeCounts.maxByOrNull { it.value }?.key

        return SmartSizes(
            portrait  = dominantPortrait?.let  { Pair(it.first.toFloat(), it.second.toFloat()) },
            landscape = dominantLandscape?.let { Pair(it.first.toFloat(), it.second.toFloat()) }
        )
    }

    private fun computeUniformSize(imagePaths: List<String>): Pair<Float, Float>? {
        var maxWidth = 0f
        var maxHeight = 0f
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }

        for (path in imagePaths) {
            BitmapFactory.decodeFile(path, opts)
            if (opts.outWidth > 0 && opts.outHeight > 0) {
                if (opts.outWidth.toFloat() > maxWidth) maxWidth = opts.outWidth.toFloat()
                if (opts.outHeight.toFloat() > maxHeight) maxHeight = opts.outHeight.toFloat()
            }
        }

        return if (maxWidth > 0 && maxHeight > 0) Pair(maxWidth, maxHeight) else null
    }
}

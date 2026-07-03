package com.assetslicer.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.net.Uri
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.exp

@CapacitorPlugin(name = "BackgroundRemoval")
class BackgroundRemovalPlugin : Plugin() {

    // Executor service to prevent concurrent thread explosion
    private val executorService = Executors.newSingleThreadExecutor()

    companion object {
        @Volatile
        private var ortEnv: OrtEnvironment? = null
        @Volatile
        private var ortSession: OrtSession? = null
        @Volatile
        private var loadedModelPath: String? = null

        // Lock to prevent concurrent session access and disposal crashes
        private val sessionLock = ReentrantLock()

        private fun getSession(env: OrtEnvironment, modelPath: String): OrtSession {
            sessionLock.withLock {
                var session = ortSession
                if (session == null || loadedModelPath != modelPath) {
                    try {
                        session?.close()
                    } catch (e: Exception) {
                        // Ignore
                    }

                    var sessionCreated = false

                    // 1. Try creating session with NNAPI hardware acceleration
                    try {
                        OrtSession.SessionOptions().use { opts ->
                            opts.addNnapi()

                            val numCores = Runtime.getRuntime().availableProcessors()
                            opts.setIntraOpNumThreads(if (numCores > 2) numCores / 2 else 1)
                            opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)

                            session = env.createSession(modelPath, opts)
                            sessionCreated = true
                        }
                    } catch (nnapiException: Exception) {
                        // NNAPI session compilation failed (e.g. driver incompatible or model has unsupported layers)
                        // Fall back to clean CPU session options below
                    }

                    // 2. Fallback: If NNAPI failed to compile, initialize standard CPU session options
                    if (!sessionCreated) {
                        OrtSession.SessionOptions().use { opts ->
                            val numCores = Runtime.getRuntime().availableProcessors()
                            opts.setIntraOpNumThreads(if (numCores > 2) numCores / 2 else 1)
                            opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)

                            session = env.createSession(modelPath, opts)
                        }
                    }

                    ortSession = session
                    loadedModelPath = modelPath
                }
                return session!!
            }
        }
    }

    private fun getNormalizedUrl(url: String): String {
        val onnxIndex = url.indexOf(".onnx", ignoreCase = true)
        if (onnxIndex != -1) {
            return url.substring(0, onnxIndex + 5)
        }
        return try {
            val parsed = URL(url)
            "${parsed.protocol}://${parsed.host}${parsed.path}"
        } catch (e: Exception) {
            url.substringBefore('?')
        }
    }

    private fun getModelFile(url: String): File {
        val normalizedUrl = getNormalizedUrl(url)
        val hash = try {
            val md = java.security.MessageDigest.getInstance("MD5")
            val bytes = md.digest(normalizedUrl.toByteArray())
            bytes.joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            normalizedUrl.hashCode().toString()
        }
        return File(context.cacheDir, "model_$hash.onnx")
    }

    @PluginMethod
    fun preloadModel(call: PluginCall) {
        val modelUrl = call.getString("url")
        if (modelUrl.isNullOrEmpty()) {
            call.reject("URL parameter is required")
            return
        }

        val context = context
        val modelFile = getModelFile(modelUrl)

        if (modelFile.exists() && modelFile.length() > 0L && !(call.getBoolean("force") ?: false)) {
            val result = JSObject()
            result.put("percent", 100)
            result.put("path", modelFile.absolutePath)
            call.resolve(result)
            return
        }

        executorService.execute {
            var connection: HttpURLConnection? = null
            var tempFile: File? = null
            try {
                var currentUrl = modelUrl
                var redirectCount = 0
                val maxRedirects = 5

                while (true) {
                    val url = URL(currentUrl)
                    connection = url.openConnection() as HttpURLConnection
                    connection.instanceFollowRedirects = true
                    connection.connect()

                    val responseCode = connection.responseCode
                    if (responseCode == HttpURLConnection.HTTP_MOVED_PERM ||
                        responseCode == HttpURLConnection.HTTP_MOVED_TEMP ||
                        responseCode == HttpURLConnection.HTTP_SEE_OTHER ||
                        responseCode == 307 || responseCode == 308) {

                        if (redirectCount >= maxRedirects) {
                            call.reject("Too many redirects")
                            return@execute
                        }
                        val newUrl = connection.getHeaderField("Location")
                        if (newUrl.isNullOrEmpty()) {
                            call.reject("Redirect response without Location header")
                            return@execute
                        }
                        currentUrl = if (newUrl.startsWith("http://") || newUrl.startsWith("https://")) {
                            newUrl
                        } else {
                            val base = URL(currentUrl)
                            URL(base, newUrl).toString()
                        }
                        redirectCount++
                        connection.disconnect()
                        continue
                    }

                    if (responseCode != HttpURLConnection.HTTP_OK) {
                        call.reject("Server returned HTTP $responseCode ${connection.responseMessage}")
                        return@execute
                    }
                    break
                }

                val fileLength = connection.contentLength
                tempFile = File(context.cacheDir, "temp_" + modelFile.name)

                connection.inputStream.use { rawInput ->
                    BufferedInputStream(rawInput).use { input ->
                        FileOutputStream(tempFile).use { output ->
                            val data = ByteArray(8192)
                            var total: Long = 0
                            var count: Int
                            var lastPercent = -1

                            while (input.read(data).also { count = it } != -1) {
                                total += count
                                output.write(data, 0, count)

                                val percent = if (fileLength > 0) {
                                    (total * 100 / fileLength).toInt()
                                } else {
                                    val estimatedSize = when {
                                        modelUrl.contains("u2netp") -> 1024L * 1024L * 4L
                                        modelUrl.contains("quantized") -> 1024L * 1024L * 43L
                                        else -> 1024L * 1024L * 120L
                                    }
                                    (total * 100 / estimatedSize).toInt().coerceAtMost(99)
                                }

                                if (percent != lastPercent) {
                                    lastPercent = percent
                                    val progressObj = JSObject()
                                    progressObj.put("percent", percent)
                                    progressObj.put("downloaded", total)
                                    progressObj.put("total", fileLength)
                                    notifyListeners("downloadProgress", progressObj)
                                }
                            }
                            output.flush()
                        }
                    }
                }

                if (modelFile.exists()) {
                    modelFile.delete()
                }

                if (tempFile.renameTo(modelFile)) {
                    val progressObj = JSObject()
                    progressObj.put("percent", 100)
                    progressObj.put("downloaded", modelFile.length())
                    progressObj.put("total", modelFile.length())
                    progressObj.put("path", modelFile.absolutePath)
                    
                    notifyListeners("downloadProgress", progressObj)
                    call.resolve(progressObj)
                } else {
                    if (tempFile.exists()) {
                        tempFile.delete()
                    }
                    call.reject("Failed to rename temporary model file")
                }
            } catch (e: Exception) {
                try {
                    if (tempFile != null && tempFile.exists()) {
                        tempFile.delete()
                    }
                } catch (cleanupEx: Exception) {
                    // Ignore
                }
                call.reject("Download failed: ${e.localizedMessage}", e)
            } finally {
                connection?.disconnect()
            }
        }
    }

    @PluginMethod
    fun removeBackground(call: PluginCall) {
        val imageStr = call.getString("image")
        if (imageStr.isNullOrEmpty()) {
            call.reject("Image parameter is required")
            return
        }

        val context = context
        val modelUrl = call.getString("url")
        val modelFile = if (!modelUrl.isNullOrEmpty()) {
            getModelFile(modelUrl)
        } else {
            val cacheFiles = context.cacheDir.listFiles { _, name -> name.startsWith("model_") && name.endsWith(".onnx") }
            if (!cacheFiles.isNullOrEmpty()) {
                cacheFiles.first()
            } else {
                File(context.cacheDir, "birefnet.onnx")
            }
        }

        if (!modelFile.exists() || modelFile.length() == 0L) {
            call.reject("Model not preloaded. Call preloadModel first. Target file: ${modelFile.name}")
            return
        }

        executorService.execute {
            // Track allocations for safety-first cleanup in finally block
            var originalBitmap: Bitmap? = null
            var resizedBitmap: Bitmap? = null
            var maskBitmap: Bitmap? = null
            var croppedMask: Bitmap? = null
            var outputBitmap: Bitmap? = null
            var inputTensor: OnnxTensor? = null
            var results: OrtSession.Result? = null

            try {
                originalBitmap = if (imageStr.startsWith("data:image")) {
                    val base64Str = imageStr.substringAfter(",")
                    val decodedBytes = Base64.decode(base64Str, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                } else if (imageStr.startsWith("content://") || imageStr.startsWith("file://") || imageStr.startsWith("/")) {
                    val uri = Uri.parse(imageStr)
                    context.contentResolver.openInputStream(uri).use { inputStream ->
                        BitmapFactory.decodeStream(inputStream)
                    }
                } else {
                    val decodedBytes = Base64.decode(imageStr, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                }

                if (originalBitmap == null) {
                    call.reject("Decoded image is null")
                    return@execute
                }

                val origWidth = originalBitmap.width
                val origHeight = originalBitmap.height

                var targetSize = call.getInt("size", 1024)!!
                var isNHWC = false
                var outputData: FloatArray? = null
                var outH = targetSize
                var outW = targetSize

                var left = 0
                var top = 0
                var newW = targetSize
                var newH = targetSize

                sessionLock.withLock {
                    var env = ortEnv
                    if (env == null) {
                        env = OrtEnvironment.getEnvironment()
                        ortEnv = env
                    }

                    val session = getSession(env, modelFile.absolutePath)
                    val inputInfo = session.inputInfo
                    val nodeInfo = inputInfo.values.firstOrNull()
                    val tensorInfo = nodeInfo?.info as? TensorInfo

                    if (tensorInfo != null) {
                        val shape = tensorInfo.shape
                        val validDimensions = shape.filter { it >= 320 }
                        if (validDimensions.isNotEmpty()) {
                            targetSize = validDimensions.first().toInt()
                        }
                        if (shape.size >= 4 && shape[3] == 3L && shape[1] != 3L) {
                            isNHWC = true
                        }
                    }

                    val scale = minOf(targetSize.toFloat() / origWidth.toFloat(), targetSize.toFloat() / origHeight.toFloat())
                    newW = minOf(targetSize, (origWidth * scale).toInt()).coerceAtLeast(1)
                    newH = minOf(targetSize, (origHeight * scale).toInt()).coerceAtLeast(1)
                    left = (targetSize - newW) / 2
                    top = (targetSize - newH) / 2

                    resizedBitmap = Bitmap.createBitmap(targetSize, targetSize, Bitmap.Config.ARGB_8888)
                    resizedBitmap.eraseColor(android.graphics.Color.BLACK)
                    val canvas = Canvas(resizedBitmap)
                    val srcRect = Rect(0, 0, origWidth, origHeight)
                    val dstRect = Rect(left, top, left + newW, top + newH)
                    val paint = Paint().apply {
                        isFilterBitmap = true
                    }
                    canvas.drawBitmap(originalBitmap, srcRect, dstRect, paint)

                    val pixels = IntArray(targetSize * targetSize)
                    resizedBitmap.getPixels(pixels, 0, targetSize, 0, 0, targetSize, targetSize)

                    val byteBuffer = ByteBuffer.allocateDirect(3 * targetSize * targetSize * 4)
                    byteBuffer.order(ByteOrder.nativeOrder())
                    val floatBuffer = byteBuffer.asFloatBuffer()

                    val rScale = 1.0f / (255.0f * 0.229f)
                    val rOffset = -0.485f / 0.229f
                    val gScale = 1.0f / (255.0f * 0.224f)
                    val gOffset = -0.456f / 0.224f
                    val bScale = 1.0f / (255.0f * 0.225f)
                    val bOffset = -0.406f / 0.225f

                    val totalPixels = targetSize * targetSize
                    val inputData = FloatArray(3 * totalPixels)

                    if (isNHWC) {
                        for (i in 0 until totalPixels) {
                            val pixel = pixels[i]
                            inputData[3 * i] = ((pixel shr 16) and 0xFF) * rScale + rOffset
                            inputData[3 * i + 1] = ((pixel shr 8) and 0xFF) * gScale + gOffset
                            inputData[3 * i + 2] = (pixel and 0xFF) * bScale + bOffset
                        }
                    } else {
                        for (i in 0 until totalPixels) {
                            val pixel = pixels[i]
                            inputData[i] = ((pixel shr 16) and 0xFF) * rScale + rOffset
                            inputData[totalPixels + i] = ((pixel shr 8) and 0xFF) * gScale + gOffset
                            inputData[2 * totalPixels + i] = (pixel and 0xFF) * bScale + bOffset
                        }
                    }

                    floatBuffer.put(inputData)
                    floatBuffer.rewind()

                    val inputName = session.inputNames.first()
                    val inputShape = if (tensorInfo != null) {
                        val shape = tensorInfo.shape.clone()
                        if (shape.isNotEmpty() && shape[0] <= 0L) {
                            shape[0] = 1L
                        }
                        shape
                    } else {
                        longArrayOf(1, 3, targetSize.toLong(), targetSize.toLong())
                    }

                    try {
                        inputTensor = OnnxTensor.createTensor(env, floatBuffer, inputShape)
                        val runResults = session.run(mapOf(inputName to inputTensor))
                        results = runResults

                        val outputTensor = runResults.get(0) as OnnxTensor
                        val outShape = outputTensor.info.shape
                        if (outShape.size >= 2) {
                            val dims = outShape.filter { it > 1 }
                            if (dims.size >= 2) {
                                outH = dims[0].toInt()
                                outW = dims[1].toInt()
                            } else if (dims.size == 1) {
                                outH = dims[0].toInt()
                                outW = dims[0].toInt()
                            } else {
                                outH = outShape[outShape.size - 2].toInt()
                                outW = outShape[outShape.size - 1].toInt()
                            }
                        } else {
                            outH = targetSize
                            outW = targetSize
                        }

                        val outBuffer = outputTensor.floatBuffer
                        val currentOutputData = FloatArray(outH * outW)
                        outBuffer.get(currentOutputData)
                        outputData = currentOutputData
                    } finally {
                        // Close tensor allocations under sessionLock before release
                        try {
                            inputTensor?.close()
                            inputTensor = null
                        } catch (e: Exception) {}
                        try {
                            results?.close()
                            results = null
                        } catch (e: Exception) {}
                    }
                }

                val finalOutputData = outputData ?: throw IllegalStateException("Model inference did not produce output data")

                // Auto-detect if model outputs are already normalized [0.0..1.0] (sigmoid already applied in ONNX model)
                var isAlreadyNormalized = true
                for (i in 0 until outW * outH) {
                    val value = finalOutputData[i]
                    if (value < 0.0f || value > 1.0f) {
                        isAlreadyNormalized = false
                        break
                    }
                }

                // Create mask pixels and compute raw soft confidence values (range 0.0 to 1.0)
                val maskPixels = IntArray(outW * outH)
                for (i in 0 until outW * outH) {
                    val rawVal = finalOutputData[i]
                    val alpha = if (isAlreadyNormalized) {
                        rawVal
                    } else {
                        1.0f / (1.0f + exp(-rawVal))
                    }
                    val alphaInt = (alpha * 255.0f).toInt().coerceIn(0, 255)
                    maskPixels[i] = (alphaInt shl 24) or 0x00FFFFFF
                }

                maskBitmap = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
                maskBitmap.setPixels(maskPixels, 0, outW, 0, 0, outW, outH)

                val maskWidth = ((newW * outW) / targetSize).coerceAtLeast(1)
                val maskHeight = ((newH * outH) / targetSize).coerceAtLeast(1)
                val maskLeft = ((left * outW) / targetSize).coerceIn(0, outW - maskWidth)
                val maskTop = ((top * outH) / targetSize).coerceIn(0, outH - maskHeight)

                croppedMask = Bitmap.createBitmap(maskBitmap, maskLeft, maskTop, maskWidth, maskHeight)

                val L = maxOf(origWidth, origHeight)
                val gMax = (L / 2).coerceIn(512, 1024)
                val subWidth: Int
                val subHeight: Int
                if (origWidth >= origHeight) {
                    subWidth = gMax
                    subHeight = Math.round(gMax.toFloat() * origHeight.toFloat() / origWidth.toFloat()).coerceAtLeast(1)
                } else {
                    subHeight = gMax
                    subWidth = Math.round(gMax.toFloat() * origWidth.toFloat() / origHeight.toFloat()).coerceAtLeast(1)
                }
                val rHigh = 6.0f + 0.001f * L
                val radiusSub = maxOf(2, Math.round(rHigh * gMax.toFloat() / L.toFloat()))
                val scaleFactor = gMax.toFloat() / L.toFloat()
                val epsilon = (1e-4f * scaleFactor * scaleFactor).coerceAtLeast(1e-6f)

                outputBitmap = GuidedFilterRefinement.refineMask(
                    originalBitmap = originalBitmap,
                    lowResMask = croppedMask!!,
                    subWidth = subWidth,
                    subHeight = subHeight,
                    radius = radiusSub,
                    epsilon = epsilon
                )

                val outputFile = File(context.cacheDir, "removed_bg_${System.currentTimeMillis()}.png")
                FileOutputStream(outputFile).use { outStream ->
                    outputBitmap.compress(Bitmap.CompressFormat.PNG, 100, outStream)
                }

                val resultObj = JSObject()
                resultObj.put("uri", Uri.fromFile(outputFile).toString())
                resultObj.put("path", outputFile.absolutePath)
                call.resolve(resultObj)

            } catch (t: Throwable) { // Catches OutOfMemoryError and crashes safely
                call.reject("Inference failed: ${t.localizedMessage}", Exception(t))
            } finally {
                // Safeguard cleanup: recycle all bitmaps and close all tensors
                originalBitmap?.recycle()
                if (resizedBitmap != originalBitmap) {
                    resizedBitmap?.recycle()
                }
                maskBitmap?.recycle()
                croppedMask?.recycle()
                outputBitmap?.recycle()

                sessionLock.withLock {
                    try {
                        inputTensor?.close()
                        inputTensor = null
                    } catch (e: Exception) {}
                    try {
                        results?.close()
                        results = null
                    } catch (e: Exception) {}
                }
            }
        }
    }

    @PluginMethod
    fun releaseModel(call: PluginCall) {
        executorService.execute {
            sessionLock.withLock {
                try {
                    ortSession?.close()
                    ortSession = null
                    ortEnv?.close()
                    ortEnv = null
                    loadedModelPath = null
                    call.resolve()
                } catch (e: Exception) {
                    call.reject("Failed to release model: ${e.message}", e)
                }
            }
        }
    }

    @PluginMethod
    fun isModelCached(call: PluginCall) {
        val modelUrl = call.getString("url")
        if (modelUrl.isNullOrEmpty()) {
            call.reject("URL parameter is required")
            return
        }
        val modelFile = getModelFile(modelUrl)
        val result = JSObject()
        result.put("isCached", modelFile.exists() && modelFile.length() > 0L)
        call.resolve(result)
    }

    @PluginMethod
    fun clearCachedModels(call: PluginCall) {
        executorService.execute {
            sessionLock.withLock {
                try {
                    ortSession?.close()
                    ortSession = null
                    ortEnv?.close()
                    ortEnv = null
                    loadedModelPath = null

                    val now = System.currentTimeMillis()
                    val cacheFiles = context.cacheDir.listFiles { _, name ->
                        (name.startsWith("model_") && name.endsWith(".onnx")) ||
                        (name.startsWith("temp_") && (name.endsWith(".onnx") || name.endsWith(".temp"))) ||
                        name == "birefnet.onnx" || name == "birefnet.temp" ||
                        (name.startsWith("removed_bg_") && name.endsWith(".png"))
                    }
                    var deletedCount = 0
                    if (cacheFiles != null) {
                        for (file in cacheFiles) {
                            if (file.name.startsWith("removed_bg_") && (now - file.lastModified() < 10000)) {
                                // Skip very recent output files to avoid breaking active UI
                                continue
                            }
                            if (file.exists() && file.delete()) {
                                deletedCount++
                            }
                        }
                    }
                    val result = JSObject()
                    result.put("deletedCount", deletedCount)
                    call.resolve(result)
                } catch (e: Exception) {
                    call.reject("Failed to clear cached models: ${e.message}", e)
                }
            }
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        executorService.execute {
            sessionLock.withLock {
                try {
                    ortSession?.close()
                    ortSession = null
                } catch (e: Exception) {}
                try {
                    ortEnv?.close()
                    ortEnv = null
                } catch (e: Exception) {}
            }
        }
        executorService.shutdown()
    }
}

/**
 * High-precision edge-refinement utility using a Fast Guided Filter.
 * Performs all heavy computations on a low-resolution grid and streams
 * the high-resolution reconstruction line-by-line to prevent memory bloat (OOM).
 */
object GuidedFilterRefinement {

    /**
     * Refines a low-resolution mask using the high-resolution original image as guidance.
     * Returns a new ARGB_8888 Bitmap of the original image's dimensions, where the alpha channel
     * contains the edge-refined mask.
     *
     * @param originalBitmap The high-resolution original image.
     * @param lowResMask The low-resolution soft mask generated by the model.
     * @param subWidth The width of the low-resolution processing grid.
     * @param subHeight The height of the low-resolution processing grid.
     * @param radius The filter window radius in the low-res grid (controls boundary smooth width).
     * @param epsilon Regularization parameter (typical range: 1e-4f to 1e-2f). Larger values reduce noise sensitivity.
     */
    fun refineMask(
        originalBitmap: Bitmap,
        lowResMask: Bitmap,
        subWidth: Int = 512,
        subHeight: Int = 512,
        radius: Int = 8,
        epsilon: Float = 1e-4f
    ): Bitmap {
        val origW = originalBitmap.width
        val origH = originalBitmap.height
        val subSize = subWidth * subHeight

        // 1. Downsample original image and mask to the processing resolution
        val I_sub = FloatArray(subSize)
        val p_sub = FloatArray(subSize)

        var guidanceSub: Bitmap? = null
        var maskSub: Bitmap? = null
        try {
            guidanceSub = Bitmap.createScaledBitmap(originalBitmap, subWidth, subHeight, true)
            maskSub = Bitmap.createScaledBitmap(lowResMask, subWidth, subHeight, true)

            val guidancePixels = IntArray(subSize)
            val maskPixels = IntArray(subSize)
            guidanceSub.getPixels(guidancePixels, 0, subWidth, 0, 0, subWidth, subHeight)
            maskSub.getPixels(maskPixels, 0, subWidth, 0, 0, subWidth, subHeight)

            // Convert guidance to normalized grayscale (luminance) and mask to [0.0..1.0] alpha
            for (i in 0 until subSize) {
                val gPix = guidancePixels[i]
                val r = (gPix shr 16) and 0xFF
                val g = (gPix shr 8) and 0xFF
                val b = gPix and 0xFF
                I_sub[i] = (0.299f * r + 0.587f * g + 0.114f * b) / 255.0f

                val mPix = maskPixels[i]
                val alpha = (mPix shr 24) and 0xFF
                p_sub[i] = alpha / 255.0f
            }
        } finally {
            guidanceSub?.recycle()
            maskSub?.recycle()
        }

        // 2. Allocate low-resolution scratch arrays (optimizing memory reuse)
        val meanI = FloatArray(subSize)   // Reused as meanA
        val meanP = FloatArray(subSize)   // Reused as meanB
        val meanIp = FloatArray(subSize)
        val meanII = FloatArray(subSize)  // Reused as b
        val temp = FloatArray(subSize)    // Reused as a
        val boxTemp = FloatArray(subSize) // Dedicated scratch buffer for box filter to avoid pointer aliasing

        // 3. Compute local statistics
        boxFilter(I_sub, subWidth, subHeight, radius, meanI, boxTemp)
        boxFilter(p_sub, subWidth, subHeight, radius, meanP, boxTemp)

        // Compute meanIp
        for (i in 0 until subSize) {
            temp[i] = I_sub[i] * p_sub[i]
        }
        boxFilter(temp, subWidth, subHeight, radius, meanIp, boxTemp)

        // Compute meanII
        for (i in 0 until subSize) {
            temp[i] = I_sub[i] * I_sub[i]
        }
        boxFilter(temp, subWidth, subHeight, radius, meanII, boxTemp)

        // 4. Solve local linear system (a = covIp / (varI + eps); b = meanP - a * meanI)
        // Reuse 'temp' for 'a' and 'meanII' for 'b'
        val a = temp
        val b = meanII
        for (i in 0 until subSize) {
            val varI = b[i] - meanI[i] * meanI[i] // b currently holds meanII
            val covIp = meanIp[i] - meanI[i] * meanP[i]
            val calculatedA = covIp / (varI + epsilon)
            val calculatedB = meanP[i] - calculatedA * meanI[i]
            a[i] = calculatedA
            b[i] = calculatedB
        }

        // 5. Smooth coefficients: meanA = boxFilter(a), meanB = boxFilter(b)
        val meanA = meanI // Reuses meanI array
        val meanB = meanP // Reuses meanP array
        boxFilter(a, subWidth, subHeight, radius, meanA, boxTemp)
        boxFilter(b, subWidth, subHeight, radius, meanB, boxTemp)

        // 6. Line-by-Line Streaming High-Resolution Reconstruction
        var outputBitmap: Bitmap? = null
        try {
            outputBitmap = Bitmap.createBitmap(origW, origH, Bitmap.Config.ARGB_8888)
            
            val origRow = IntArray(origW)
            val outRow = IntArray(origW)

            val xRatio = (subWidth - 1).toFloat() / (origW - 1).toFloat()
            val yRatio = (subHeight - 1).toFloat() / (origH - 1).toFloat()

            for (y in 0 until origH) {
                // Read a single line of pixels from the original image
                originalBitmap.getPixels(origRow, 0, origW, 0, y, origW, 1)

                val ySub = y * yRatio
                val y0 = ySub.toInt()
                val y1 = (y0 + 1).coerceAtMost(subHeight - 1)
                val dy = ySub - y0
                val wy0 = 1.0f - dy
                val wy1 = dy

                val y0Offset = y0 * subWidth
                val y1Offset = y1 * subWidth

                for (x in 0 until origW) {
                    val pixel = origRow[x]
                    val r = (pixel shr 16) and 0xFF
                    val g = (pixel shr 8) and 0xFF
                    val b = pixel and 0xFF
                    val yVal = (0.299f * r + 0.587f * g + 0.114f * b) / 255.0f

                    // Bilinear mapping to low-res coordinates
                    val xSub = x * xRatio
                    val x0 = xSub.toInt()
                    val x1 = (x0 + 1).coerceAtMost(subWidth - 1)
                    val dx = xSub - x0
                    val wx0 = 1.0f - dx
                    val wx1 = dx

                    // Interpolate a
                    val a_y0 = wx0 * meanA[y0Offset + x0] + wx1 * meanA[y0Offset + x1]
                    val a_y1 = wx0 * meanA[y1Offset + x0] + wx1 * meanA[y1Offset + x1]
                    val aInterp = wy0 * a_y0 + wy1 * a_y1

                    // Interpolate b
                    val b_y0 = wx0 * meanB[y0Offset + x0] + wx1 * meanB[y0Offset + x1]
                    val b_y1 = wx0 * meanB[y1Offset + x0] + wx1 * meanB[y1Offset + x1]
                    val bInterp = wy0 * b_y0 + wy1 * b_y1

                    // Apply linear transformation and clamp
                    val refinedAlpha = (aInterp * yVal + bInterp).coerceIn(0.0f, 1.0f)
                    val alphaInt = (refinedAlpha * 255.0f).toInt()

                    // Assemble destination pixel retaining original RGB colors
                    outRow[x] = (alphaInt shl 24) or (pixel and 0x00FFFFFF)
                }
                // Write the processed line back to output
                outputBitmap.setPixels(outRow, 0, origW, 0, y, origW, 1)
            }
            return outputBitmap
        } catch (t: Throwable) {
            outputBitmap?.recycle()
            throw t
        }
    }

    /**
     * Separable 2D Box Filter. O(W * H) running time.
     * Smooths [img] along rows then columns using [boxTemp] as horizontal pass scratch.
     */
    private fun boxFilter(
        img: FloatArray,
        width: Int,
        height: Int,
        radius: Int,
        output: FloatArray,
        boxTemp: FloatArray
    ) {
        // Horizontal pass: Row-by-row moving average
        for (y in 0 until height) {
            val rowOffset = y * width
            var sum = 0.0f
            
            val initialSize = radius.coerceAtMost(width - 1)
            for (x in 0..initialSize) {
                sum += img[rowOffset + x]
            }
            
            for (x in 0 until width) {
                val left = (x - radius).coerceAtLeast(0)
                val right = (x + radius).coerceAtMost(width - 1)
                val windowSize = right - left + 1
                
                if (x > 0) {
                    if (x + radius < width) {
                        sum += img[rowOffset + x + radius]
                    }
                    if (x - radius - 1 >= 0) {
                        sum -= img[rowOffset + x - radius - 1]
                    }
                }
                boxTemp[rowOffset + x] = sum / windowSize
            }
        }

        // Vertical pass: Column-by-column moving average on horizontal pass results
        for (x in 0 until width) {
            var sum = 0.0f
            
            val initialSize = radius.coerceAtMost(height - 1)
            for (y in 0..initialSize) {
                sum += boxTemp[y * width + x]
            }
            
            for (y in 0 until height) {
                val top = (y - radius).coerceAtLeast(0)
                val bottom = (y + radius).coerceAtMost(height - 1)
                val windowSize = bottom - top + 1
                
                if (y > 0) {
                    if (y + radius < height) {
                        sum += boxTemp[(y + radius) * width + x]
                    }
                    if (y - radius - 1 >= 0) {
                        sum -= boxTemp[(y - radius - 1) * width + x]
                    }
                }
                output[y * width + x] = sum / windowSize
            }
        }
    }
}

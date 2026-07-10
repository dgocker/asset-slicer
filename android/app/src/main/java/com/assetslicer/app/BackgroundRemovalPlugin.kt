package com.assetslicer.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.net.Uri
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
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
import java.util.concurrent.Executors
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.exp

@CapacitorPlugin(name = "BackgroundRemoval")
class BackgroundRemovalPlugin : Plugin() {

    // Executor service to prevent concurrent thread explosion
    private val executorService = Executors.newSingleThreadExecutor()

    companion object {
        /** Ключ tree-URI папки экспорта в SharedPreferences("export_prefs"). */
        private const val EXPORT_TREE_URI_KEY = "tree_uri"

        /** Общий объём ОЗУ устройства (байты); заполняется в load(). 0 = неизвестно. */
        @Volatile
        var totalDeviceMemBytes: Long = 0L

        @Volatile
        private var ortEnv: OrtEnvironment? = null
        @Volatile
        private var ortSession: OrtSession? = null
        @Volatile
        private var loadedModelPath: String? = null

        // Lock to prevent concurrent session access and disposal crashes
        private val sessionLock = ReentrantLock()

        // --- MobileSAM: ОТДЕЛЬНОЕ состояние (не пересекается с ortSession выше) ---
        @Volatile
        private var samEncoderSession: OrtSession? = null
        @Volatile
        private var samEncoderPath: String? = null
        @Volatile
        private var samDecoderSession: OrtSession? = null
        @Volatile
        private var samDecoderPath: String? = null
        /** Embedding текущего листа [1,256,64,64]; живёт от samPrepare до samRelease. */
        @Volatile
        private var samEmbedding: OnnxTensor? = null
        @Volatile
        private var samOrigW = 0
        @Volatile
        private var samOrigH = 0
        /** Масштаб 1024-кадра декодера: coord1024 = coordOrig * samScale. */
        @Volatile
        private var samScale = 1f
        // Отдельный лок: SAM-вызовы не должны конкурировать с вырезанием фона
        private val samLock = ReentrantLock()

        private fun getSession(env: OrtEnvironment, modelPath: String, preferCpu: Boolean = false): OrtSession {
            sessionLock.withLock {
                var session = ortSession
                if (session == null || loadedModelPath != modelPath) {
                    try {
                        session?.close()
                    } catch (e: Exception) {
                        // Ignore
                    }

                    var sessionCreated = false

                    // 1. Try creating session with NNAPI hardware acceleration.
                    // Transformer models (BiRefNet: Swin + decomposed deform_conv/GridSample)
                    // partition terribly on NNAPI — constant CPU<->NNAPI ping-pong makes them
                    // many times SLOWER than plain CPU. For those, skip straight to CPU.
                    if (!preferCpu) try {
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

                    // 2. Fallback: If NNAPI failed to compile, initialize standard CPU session options.
                    // Full throttle: all cores minus one (one is left for the UI thread so the
                    // app stays responsive) + full graph optimization level.
                    if (!sessionCreated) {
                        OrtSession.SessionOptions().use { opts ->
                            val numCores = Runtime.getRuntime().availableProcessors()
                            // Адаптация под железо: на устройствах с малым ОЗУ (<4ГБ)
                            // ограничиваем потоки — каждый поток инференса добавляет
                            // рабочие буферы, и на слабых устройствах 8 потоков дают
                            // давление на память без выигрыша по скорости.
                            val lowRam = totalDeviceMemBytes in 1..(4L * 1024 * 1024 * 1024)
                            val threads = if (lowRam) minOf(4, maxOf(1, numCores - 1))
                                          else maxOf(1, numCores - 1)
                            opts.setIntraOpNumThreads(threads)
                            opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
                            // Без арены: ORT по умолчанию НЕ возвращает память ОС между
                            // прогонами — на больших моделях (BiRefNet base: гигабайты
                            // активаций за прогон) второй объект подряд убивал приложение
                            // по памяти. С выключенной ареной пик один и тот же на каждый
                            // объект, а не накапливается.
                            opts.setCPUArenaAllocator(false)
                            opts.setMemoryPatternOptimization(false)

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

    override fun load() {
        super.load()
        try {
            val am = context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            val mi = android.app.ActivityManager.MemoryInfo()
            am.getMemoryInfo(mi)
            totalDeviceMemBytes = mi.totalMem
        } catch (e: Exception) {
            // неизвестное железо — работаем с дефолтами
        }
    }

    /** Информация об устройстве для адаптации UI (рекомендации моделей по ОЗУ). */
    @PluginMethod
    fun getDeviceInfo(call: PluginCall) {
        val res = JSObject()
        res.put("totalMemBytes", totalDeviceMemBytes)
        res.put("cores", Runtime.getRuntime().availableProcessors())
        call.resolve(res)
    }

    @PluginMethod
    fun preloadModel(call: PluginCall) {
        val modelUrl = call.getString("url")
        if (modelUrl.isNullOrEmpty()) {
            call.reject("URL parameter is required")
            return
        }
        val expectedSha256 = call.getString("sha256")

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
            val partFile = File(context.cacheDir, "temp_" + modelFile.name)
            try {
                var currentUrl = modelUrl
                var redirectCount = 0
                val maxRedirects = 5

                // Resume support: if a previous attempt left a partial file, continue it via HTTP Range
                var existingBytes = if (partFile.exists()) partFile.length() else 0L
                var resumed = false
                var rangeRetried = false

                while (true) {
                    val url = URL(currentUrl)
                    connection = url.openConnection() as HttpURLConnection
                    // Без таймаутов зависшее мобильное соединение никогда не резолвит
                    // и не реджектит JS-промис — экран обработки застревает навсегда
                    connection.connectTimeout = 30_000
                    connection.readTimeout = 30_000
                    connection.instanceFollowRedirects = true
                    if (existingBytes > 0L) {
                        connection.setRequestProperty("Range", "bytes=$existingBytes-")
                    }
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

                    if (responseCode == HttpURLConnection.HTTP_PARTIAL) {
                        // Server honors the Range header — continue the interrupted download
                        resumed = true
                        break
                    }
                    if (responseCode == HttpURLConnection.HTTP_OK) {
                        // No Range was sent, or the server ignored it — download from scratch
                        existingBytes = 0L
                        resumed = false
                        break
                    }
                    if (responseCode == 416 && existingBytes > 0L && !rangeRetried) {
                        // Range Not Satisfiable: stale/oversized partial file — drop it and retry
                        rangeRetried = true
                        partFile.delete()
                        existingBytes = 0L
                        connection.disconnect()
                        continue
                    }

                    call.reject("Server returned HTTP $responseCode ${connection.responseMessage}")
                    return@execute
                }

                val remainingLength = connection.contentLength
                val totalBytes = if (remainingLength > 0) existingBytes + remainingLength else -1L

                connection.inputStream.use { rawInput ->
                    BufferedInputStream(rawInput).use { input ->
                        FileOutputStream(partFile, existingBytes > 0L).use { output ->
                            val data = ByteArray(8192)
                            var total: Long = existingBytes
                            var count: Int
                            var lastPercent = -1
                            var lastByteEventAt = 0L

                            while (input.read(data).also { count = it } != -1) {
                                total += count
                                output.write(data, 0, count)

                                val percent = if (totalBytes > 0) {
                                    (total * 100 / totalBytes).toInt()
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
                                    progressObj.put("total", totalBytes)
                                    notifyListeners("downloadProgress", progressObj)

                                    // Byte-level progress event (throttled to ~4/sec)
                                    val now = System.currentTimeMillis()
                                    if (now - lastByteEventAt >= 250L) {
                                        lastByteEventAt = now
                                        val byteObj = JSObject()
                                        byteObj.put("loaded", total)
                                        byteObj.put("total", if (totalBytes > 0) totalBytes else 0L)
                                        byteObj.put("resumed", resumed)
                                        notifyListeners("modelDownloadProgress", byteObj)
                                    }
                                }
                            }
                            output.flush()
                        }
                    }
                }

                // Truncated stream: keep the partial file so the next attempt resumes it
                if (totalBytes > 0 && partFile.length() < totalBytes) {
                    call.reject("Download incomplete: got ${partFile.length()} of $totalBytes bytes. Retry to resume.")
                    return@execute
                }

                // Integrity check: verify the SHA-256 checksum when the caller provided one
                if (!expectedSha256.isNullOrEmpty()) {
                    val actualSha256 = computeSha256(partFile)
                    if (!actualSha256.equals(expectedSha256, ignoreCase = true)) {
                        partFile.delete()
                        call.reject("Model checksum mismatch: expected $expectedSha256, got $actualSha256")
                        return@execute
                    }
                }

                if (modelFile.exists()) {
                    modelFile.delete()
                }

                if (partFile.renameTo(modelFile)) {
                    val progressObj = JSObject()
                    progressObj.put("percent", 100)
                    progressObj.put("downloaded", modelFile.length())
                    progressObj.put("total", modelFile.length())
                    progressObj.put("path", modelFile.absolutePath)

                    notifyListeners("downloadProgress", progressObj)

                    val byteObj = JSObject()
                    byteObj.put("loaded", modelFile.length())
                    byteObj.put("total", modelFile.length())
                    byteObj.put("resumed", resumed)
                    notifyListeners("modelDownloadProgress", byteObj)

                    call.resolve(progressObj)
                } else {
                    if (partFile.exists()) {
                        partFile.delete()
                    }
                    call.reject("Failed to rename temporary model file")
                }
            } catch (e: Exception) {
                // The partial file is intentionally kept: the next attempt resumes it via HTTP Range
                call.reject("Download failed: ${e.localizedMessage}", e)
            } finally {
                connection?.disconnect()
            }
        }
    }

    /** Декодирует вход image (dataURL / чистый base64 / content://, file://, путь) в Bitmap. */
    private fun decodeImageInput(imageStr: String): Bitmap? {
        return if (imageStr.startsWith("data:image")) {
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
    }

    private fun computeSha256(file: File): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
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
                originalBitmap = decodeImageInput(imageStr)

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

                    val preferCpuSession = listOfNotNull(modelUrl, modelFile.name)
                        .joinToString(" ").lowercase().contains("birefnet")
                    val session = getSession(env, modelFile.absolutePath, preferCpuSession)
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

                    // Stretch-resize to targetSize×targetSize (official RMBG/IS-Net preprocessing).
                    // Letterboxing on a solid backdrop makes the salient-object model treat the
                    // whole padded sheet as one foreground object, so nothing gets removed.
                    newW = targetSize
                    newH = targetSize
                    left = 0
                    top = 0

                    resizedBitmap = Bitmap.createBitmap(targetSize, targetSize, Bitmap.Config.ARGB_8888)
                    val canvas = Canvas(resizedBitmap)
                    val srcRect = Rect(0, 0, origWidth, origHeight)
                    val dstRect = Rect(0, 0, targetSize, targetSize)
                    val paint = Paint().apply {
                        isFilterBitmap = true
                    }
                    canvas.drawBitmap(originalBitmap, srcRect, dstRect, paint)

                    val pixels = IntArray(targetSize * targetSize)
                    resizedBitmap.getPixels(pixels, 0, targetSize, 0, 0, targetSize, targetSize)

                    // Detect model type for correct normalization — check URL, file name, and file path
                    val modelIdStr = listOfNotNull(modelUrl, modelFile.name, modelFile.absolutePath)
                        .joinToString(" ").lowercase()
                    // ImageNet norm only for explicitly known models; RMBG-style (simple) norm is the safe default
                    val isImageNetNorm = modelIdStr.contains("u2net") || modelIdStr.contains("isnet") ||
                            modelIdStr.contains("birefnet")
                    val rScale: Float; val rOffset: Float
                    val gScale: Float; val gOffset: Float
                    val bScale: Float; val bOffset: Float
                    if (!isImageNetNorm) {
                        // RMBG-1.4: normalize(img, mean=[0.5,0.5,0.5], std=[1.0,1.0,1.0])
                        // Formula: pixel/255 - 0.5
                        rScale = 1.0f / 255.0f; rOffset = -0.5f
                        gScale = 1.0f / 255.0f; gOffset = -0.5f
                        bScale = 1.0f / 255.0f; bOffset = -0.5f
                    } else {
                        rScale = 1.0f / (255.0f * 0.229f); rOffset = -0.485f / 0.229f
                        gScale = 1.0f / (255.0f * 0.224f); gOffset = -0.456f / 0.224f
                        bScale = 1.0f / (255.0f * 0.225f); bOffset = -0.406f / 0.225f
                    }

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
                        // Heap-backed buffer: ORT copies it internally; avoids piling up
                        // 12.6MB direct ByteBuffers per call (GC frees those lazily -> native OOM
                        // after ~10 sequential per-object inferences)
                        inputTensor = OnnxTensor.createTensor(env, java.nio.FloatBuffer.wrap(inputData), inputShape)
                        val runResults = session.run(mapOf(inputName to inputTensor))
                        results = runResults

                        val outputTensor = runResults.get(0) as OnnxTensor
                        val outShape = outputTensor.info.shape
                        when (outShape.size) {
                            4 -> {
                                if (outShape[3] == 1L && outShape[1] > 1L) {
                                    // NHWC: [batch, height, width, channels]
                                    outH = outShape[1].toInt()
                                    outW = outShape[2].toInt()
                                } else {
                                    // NCHW: [batch, channels, height, width]
                                    outH = outShape[2].toInt()
                                    outW = outShape[3].toInt()
                                }
                            }
                            3 -> {
                                outH = outShape[1].toInt()
                                outW = outShape[2].toInt()
                            }
                            2 -> {
                                outH = outShape[0].toInt()
                                outW = outShape[1].toInt()
                            }
                            else -> {
                                outH = targetSize
                                outW = targetSize
                            }
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
                var minVal = Float.MAX_VALUE
                // NOTE: Float.MIN_VALUE is the smallest POSITIVE float, not the most negative
                // one — it would break the min-max stretch when all outputs are <= 0.
                var maxVal = Float.NEGATIVE_INFINITY
                for (i in 0 until outW * outH) {
                    val value = finalOutputData[i]
                    if (value < minVal) minVal = value
                    if (value > maxVal) maxVal = value
                    if (value < -0.05f || value > 1.05f) {
                        isAlreadyNormalized = false
                    }
                }

                // Create mask pixels and compute raw soft confidence values (range 0.0 to 1.0)
                val maskPixels = IntArray(outW * outH)
                val range = maxVal - minVal
                for (i in 0 until outW * outH) {
                    val rawVal = finalOutputData[i]
                    val alpha = if (!isAlreadyNormalized) {
                        1.0f / (1.0f + exp(-rawVal))
                    } else if (range > 0.01f) {
                        // Min-max normalize: (val - min) / (max - min) as per RMBG-1.4 postprocessing
                        ((rawVal - minVal) / range).coerceIn(0.0f, 1.0f)
                    } else {
                        rawVal.coerceIn(0.0f, 1.0f)
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

                val rawMode = call.getBoolean("raw") ?: false
                if (rawMode) {
                    // raw=true: apply the model mask (after sigmoid/min-max) directly as alpha,
                    // skipping guided filter and EdgeCleanup (per-object pipeline contract).
                    var scaledMask: Bitmap? = null
                    try {
                        scaledMask = Bitmap.createScaledBitmap(croppedMask!!, origWidth, origHeight, true)
                        val rawOutput = Bitmap.createBitmap(origWidth, origHeight, Bitmap.Config.ARGB_8888)
                        outputBitmap = rawOutput
                        val origRow = IntArray(origWidth)
                        val maskRow = IntArray(origWidth)
                        for (y in 0 until origHeight) {
                            originalBitmap.getPixels(origRow, 0, origWidth, 0, y, origWidth, 1)
                            scaledMask.getPixels(maskRow, 0, origWidth, 0, y, origWidth, 1)
                            for (x in 0 until origWidth) {
                                origRow[x] = (maskRow[x] and 0xFF000000.toInt()) or (origRow[x] and 0x00FFFFFF)
                            }
                            rawOutput.setPixels(origRow, 0, origWidth, 0, y, origWidth, 1)
                        }
                    } finally {
                        if (scaledMask != croppedMask) {
                            scaledMask?.recycle()
                        }
                    }
                } else {
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
                    val epsilon = 1e-4f

                    outputBitmap = GuidedFilterRefinement.refineMask(
                        originalBitmap = originalBitmap,
                        lowResMask = croppedMask!!,
                        subWidth = subWidth,
                        subHeight = subHeight,
                        radius = radiusSub,
                        epsilon = epsilon
                    )

                    // Edge cleanup: erosion → AA → color decontamination.
                    // The original bitmap supplies the RGB source: the refined bitmap is
                    // premultiplied, so its fully transparent pixels read back as black.
                    EdgeCleanup.apply(outputBitmap, originalBitmap)
                }

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

    // ---------- MobileSAM: движок выделения по промпту (точки / рамка) ----------

    /** CPU-опции ORT-сессии для SAM: как в CPU-пути вырезания (арена выключена). */
    private fun samSessionOptions(): OrtSession.SessionOptions {
        val opts = OrtSession.SessionOptions()
        val numCores = Runtime.getRuntime().availableProcessors()
        opts.setIntraOpNumThreads(maxOf(1, numCores - 1))
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        opts.setCPUArenaAllocator(false)
        opts.setMemoryPatternOptimization(false)
        return opts
    }

    /**
     * Готовит SAM для листа: создаёт/кэширует сессии энкодера и декодера,
     * прогоняет энкодер по изображению и сохраняет embedding [1,256,64,64].
     * Контракт энкодера: вход `input_image` float32 [H,W,3] RGB, СЫРЫЕ пиксели
     * 0..255 (нормализация и zero-паддинг до 1024×1024 зашиты в граф); снаружи
     * только bilinear-resize с сохранением аспекта (длинная сторона = 1024).
     * Обе модели должны быть заранее скачаны через preloadModel.
     */
    @PluginMethod
    fun samPrepare(call: PluginCall) {
        val encoderUrl = call.getString("encoderUrl")
        val decoderUrl = call.getString("decoderUrl")
        val imageStr = call.getString("image")
        if (encoderUrl.isNullOrEmpty() || decoderUrl.isNullOrEmpty() || imageStr.isNullOrEmpty()) {
            call.reject("encoderUrl, decoderUrl and image parameters are required")
            return
        }
        val encoderFile = getModelFile(encoderUrl)
        val decoderFile = getModelFile(decoderUrl)
        if (!encoderFile.exists() || encoderFile.length() == 0L ||
            !decoderFile.exists() || decoderFile.length() == 0L
        ) {
            call.reject("SAM model not preloaded. Call preloadModel for encoder and decoder first.")
            return
        }

        executorService.execute {
            var originalBitmap: Bitmap? = null
            var resizedBitmap: Bitmap? = null
            var inputTensor: OnnxTensor? = null
            var results: OrtSession.Result? = null
            samLock.withLock {
                try {
                    val env = OrtEnvironment.getEnvironment()

                    var encoder = samEncoderSession
                    if (encoder == null || samEncoderPath != encoderFile.absolutePath) {
                        try { samEncoderSession?.close() } catch (e: Exception) {}
                        samSessionOptions().use { opts ->
                            encoder = env.createSession(encoderFile.absolutePath, opts)
                        }
                        samEncoderSession = encoder
                        samEncoderPath = encoderFile.absolutePath
                    }
                    if (samDecoderSession == null || samDecoderPath != decoderFile.absolutePath) {
                        try { samDecoderSession?.close() } catch (e: Exception) {}
                        samSessionOptions().use { opts ->
                            samDecoderSession = env.createSession(decoderFile.absolutePath, opts)
                        }
                        samDecoderPath = decoderFile.absolutePath
                    }

                    originalBitmap = decodeImageInput(imageStr)
                    val bitmap = originalBitmap
                    if (bitmap == null) {
                        call.reject("Decoded image is null")
                        return@execute
                    }
                    val origW = bitmap.width
                    val origH = bitmap.height

                    // Resize с сохранением аспекта: длинная сторона = 1024
                    val scale = 1024f / maxOf(origW, origH)
                    val newW = Math.round(origW * scale).coerceIn(1, 1024)
                    val newH = Math.round(origH * scale).coerceIn(1, 1024)
                    resizedBitmap = Bitmap.createScaledBitmap(bitmap, newW, newH, true)

                    val pixels = IntArray(newW * newH)
                    resizedBitmap!!.getPixels(pixels, 0, newW, 0, 0, newW, newH)
                    // HWC RGB, сырые значения 0..255 (без нормализации — она в графе)
                    val inputData = FloatArray(newW * newH * 3)
                    for (i in 0 until newW * newH) {
                        val p = pixels[i]
                        inputData[3 * i] = ((p shr 16) and 0xFF).toFloat()
                        inputData[3 * i + 1] = ((p shr 8) and 0xFF).toFloat()
                        inputData[3 * i + 2] = (p and 0xFF).toFloat()
                    }
                    inputTensor = OnnxTensor.createTensor(
                        env,
                        java.nio.FloatBuffer.wrap(inputData),
                        longArrayOf(newH.toLong(), newW.toLong(), 3L)
                    )

                    val session = encoder!!
                    val inputName = session.inputNames.first()
                    results = session.run(mapOf(inputName to inputTensor))
                    val embOut = results!!.get(0) as OnnxTensor
                    // Тензоры Result закрываются вместе с ним — embedding живёт
                    // между вызовами, поэтому данные копируются в собственный тензор
                    val embCopy = OnnxTensor.createTensor(env, embOut.floatBuffer, embOut.info.shape.clone())
                    try { samEmbedding?.close() } catch (e: Exception) {}
                    samEmbedding = embCopy
                    samOrigW = origW
                    samOrigH = origH
                    samScale = scale

                    val res = JSObject()
                    res.put("width", origW)
                    res.put("height", origH)
                    call.resolve(res)
                } catch (t: Throwable) { // включая OutOfMemoryError
                    call.reject("SAM prepare failed: ${t.localizedMessage}", Exception(t))
                } finally {
                    if (resizedBitmap != originalBitmap) resizedBitmap?.recycle()
                    originalBitmap?.recycle()
                    try { inputTensor?.close() } catch (e: Exception) {}
                    try { results?.close() } catch (e: Exception) {}
                }
            }
        }
    }

    /**
     * Прогон декодера SAM по промпту (точки и/или рамка в пикселях ОРИГИНАЛА).
     * Контракт: point_coords в системе 1024-кадра (coord * samScale); метки:
     * 1 = точка объекта, 2/3 = углы рамки, -1 = padding (обязателен для промпта
     * из одних точек); orig_im_size = (H, W); выход masks [1,1,H,W] — логиты,
     * бинаризация mask > 0. Ответ: PNG-маска (белый = объект) в base64.
     */
    @PluginMethod
    fun samPrompt(call: PluginCall) {
        val pointsArr = call.getArray("points")
        val boxObj = call.getObject("box")
        if ((pointsArr == null || pointsArr.length() == 0) && boxObj == null) {
            call.reject("points or box parameter is required")
            return
        }

        executorService.execute {
            var coordsTensor: OnnxTensor? = null
            var labelsTensor: OnnxTensor? = null
            var maskInputTensor: OnnxTensor? = null
            var hasMaskTensor: OnnxTensor? = null
            var origSizeTensor: OnnxTensor? = null
            var results: OrtSession.Result? = null
            var maskBitmap: Bitmap? = null
            samLock.withLock {
                try {
                    val emb = samEmbedding
                    val decoder = samDecoderSession
                    if (emb == null || decoder == null) {
                        call.reject("SAM not prepared. Call samPrepare first.")
                        return@execute
                    }
                    val env = OrtEnvironment.getEnvironment()

                    val coords = ArrayList<Float>()
                    val labels = ArrayList<Float>()
                    if (pointsArr != null) {
                        for (i in 0 until pointsArr.length()) {
                            val o = pointsArr.getJSONObject(i)
                            coords.add(o.getDouble("x").toFloat() * samScale)
                            coords.add(o.getDouble("y").toFloat() * samScale)
                            labels.add((if (o.has("label")) o.getInt("label") else 1).toFloat())
                        }
                    }
                    if (boxObj != null) {
                        coords.add(boxObj.getDouble("x0").toFloat() * samScale)
                        coords.add(boxObj.getDouble("y0").toFloat() * samScale)
                        labels.add(2f)
                        coords.add(boxObj.getDouble("x1").toFloat() * samScale)
                        coords.add(boxObj.getDouble("y1").toFloat() * samScale)
                        labels.add(3f)
                    } else {
                        // Промпт из одних точек: обязательная padding-точка
                        coords.add(0f)
                        coords.add(0f)
                        labels.add(-1f)
                    }
                    val n = labels.size.toLong()
                    coordsTensor = OnnxTensor.createTensor(
                        env, java.nio.FloatBuffer.wrap(coords.toFloatArray()), longArrayOf(1, n, 2)
                    )
                    labelsTensor = OnnxTensor.createTensor(
                        env, java.nio.FloatBuffer.wrap(labels.toFloatArray()), longArrayOf(1, n)
                    )
                    maskInputTensor = OnnxTensor.createTensor(
                        env, java.nio.FloatBuffer.wrap(FloatArray(256 * 256)), longArrayOf(1, 1, 256, 256)
                    )
                    hasMaskTensor = OnnxTensor.createTensor(
                        env, java.nio.FloatBuffer.wrap(floatArrayOf(0f)), longArrayOf(1)
                    )
                    origSizeTensor = OnnxTensor.createTensor(
                        env,
                        java.nio.FloatBuffer.wrap(floatArrayOf(samOrigH.toFloat(), samOrigW.toFloat())),
                        longArrayOf(2)
                    )

                    results = decoder.run(
                        mapOf(
                            "image_embeddings" to emb,
                            "point_coords" to coordsTensor!!,
                            "point_labels" to labelsTensor!!,
                            "mask_input" to maskInputTensor!!,
                            "has_mask_input" to hasMaskTensor!!,
                            "orig_im_size" to origSizeTensor!!
                        )
                    )

                    val masksVal = results!!.get("masks")
                    val masksTensor =
                        (if (masksVal.isPresent) masksVal.get() else results!!.get(0)) as OnnxTensor
                    val mShape = masksTensor.info.shape
                    val mh = mShape[mShape.size - 2].toInt()
                    val mw = mShape[mShape.size - 1].toInt()

                    var iou = 0f
                    try {
                        val iouVal = results!!.get("iou_predictions")
                        if (iouVal.isPresent) {
                            val buf = (iouVal.get() as OnnxTensor).floatBuffer
                            if (buf.remaining() > 0) iou = buf.get(0)
                        }
                    } catch (e: Exception) {
                        // iou опционален — маска важнее
                    }

                    // Построчно (логиты origH×origW могут быть десятки МБ):
                    // бинаризация >0 → белый непрозрачный пиксель, иначе прозрачный.
                    // ALPHA_8 в PNG прозрачность не сохраняет корректно — ARGB.
                    val fb = masksTensor.floatBuffer
                    maskBitmap = Bitmap.createBitmap(mw, mh, Bitmap.Config.ARGB_8888)
                    val rowF = FloatArray(mw)
                    val rowPx = IntArray(mw)
                    for (y in 0 until mh) {
                        fb.get(rowF)
                        for (x in 0 until mw) {
                            rowPx[x] = if (rowF[x] > 0f) 0xFFFFFFFF.toInt() else 0
                        }
                        maskBitmap!!.setPixels(rowPx, 0, mw, 0, y, mw, 1)
                    }

                    val baos = java.io.ByteArrayOutputStream()
                    maskBitmap!!.compress(Bitmap.CompressFormat.PNG, 100, baos)
                    val maskBase64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)

                    val res = JSObject()
                    res.put("maskBase64", maskBase64)
                    res.put("width", mw)
                    res.put("height", mh)
                    res.put("iou", iou)
                    call.resolve(res)
                } catch (t: Throwable) { // включая OutOfMemoryError
                    call.reject("SAM prompt failed: ${t.localizedMessage}", Exception(t))
                } finally {
                    maskBitmap?.recycle()
                    try { coordsTensor?.close() } catch (e: Exception) {}
                    try { labelsTensor?.close() } catch (e: Exception) {}
                    try { maskInputTensor?.close() } catch (e: Exception) {}
                    try { hasMaskTensor?.close() } catch (e: Exception) {}
                    try { origSizeTensor?.close() } catch (e: Exception) {}
                    try { results?.close() } catch (e: Exception) {}
                }
            }
        }
    }

    /** Освобождает embedding листа (сессии SAM остаются — их прогрев дорогой). */
    @PluginMethod
    fun samRelease(call: PluginCall) {
        executorService.execute {
            samLock.withLock {
                try { samEmbedding?.close() } catch (e: Exception) {}
                samEmbedding = null
                samOrigW = 0
                samOrigH = 0
                call.resolve()
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

    // ---------- Экспорт ассетов в выбранную пользователем папку (SAF) ----------

    private fun exportPrefs() =
        context.getSharedPreferences("export_prefs", Context.MODE_PRIVATE)

    /** Сохранённый tree-URI папки экспорта, если persistable-права ещё живы. */
    private fun persistedTreeUri(): Uri? {
        val uriStr = exportPrefs().getString(EXPORT_TREE_URI_KEY, null) ?: return null
        val uri = Uri.parse(uriStr)
        val stillGranted = context.contentResolver.persistedUriPermissions.any {
            it.uri == uri && it.isWritePermission
        }
        return if (stillGranted) uri else null
    }

    /** Открывает системный выбор папки (ACTION_OPEN_DOCUMENT_TREE). */
    @PluginMethod
    fun pickExportFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
        startActivityForResult(call, intent, "onFolderPicked")
    }

    @ActivityCallback
    fun onFolderPicked(call: PluginCall, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.reject("Folder selection cancelled")
            return
        }
        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (e: SecurityException) {
            call.reject("Failed to persist folder permission: ${e.message}", e)
            return
        }
        exportPrefs().edit().putString(EXPORT_TREE_URI_KEY, uri.toString()).apply()

        val name = DocumentFile.fromTreeUri(context, uri)?.name
            ?: uri.lastPathSegment
            ?: "folder"
        val res = JSObject()
        res.put("uri", uri.toString())
        res.put("name", name)
        call.resolve(res)
    }

    /** Ранее выбранная папка экспорта ({} — не выбрана или права отозваны). */
    @PluginMethod
    fun getExportFolder(call: PluginCall) {
        val res = JSObject()
        val uri = persistedTreeUri()
        if (uri != null) {
            val doc = DocumentFile.fromTreeUri(context, uri)
            if (doc != null && doc.canWrite()) {
                res.put("uri", uri.toString())
                res.put("name", doc.name ?: uri.lastPathSegment ?: "folder")
            }
        }
        call.resolve(res)
    }

    /**
     * Пишет файл (base64, dataURL-префикс допустим) в выбранную SAF-папку.
     * resolve({saved:false, reason:'no-folder'}) — папка не выбрана либо
     * права протухли (SecurityException); reject — реальная ошибка записи.
     */
    @PluginMethod
    fun saveToExportFolder(call: PluginCall) {
        val filename = call.getString("filename")
        val base64 = call.getString("base64")
        if (filename.isNullOrEmpty() || base64.isNullOrEmpty()) {
            call.reject("filename and base64 parameters are required")
            return
        }
        val mime = call.getString("mime") ?: "application/octet-stream"

        executorService.execute {
            try {
                val treeUri = persistedTreeUri()
                val dir = if (treeUri != null) DocumentFile.fromTreeUri(context, treeUri) else null
                if (treeUri == null || dir == null || !dir.canWrite()) {
                    val res = JSObject()
                    res.put("saved", false)
                    res.put("reason", "no-folder")
                    call.resolve(res)
                    return@execute
                }

                // Отрезаем dataURL-префикс ("data:image/png;base64,..."), если есть
                val cleanBase64 = base64.substringAfter(',', base64)
                val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)

                // Существующее имя система дополнит суффиксом автоматически
                val file = dir.createFile(mime, filename)
                    ?: throw Exception("Failed to create file in the selected folder")
                val output = context.contentResolver.openOutputStream(file.uri)
                    ?: throw Exception("Failed to open output stream for ${file.uri}")
                output.use { it.write(bytes) }

                val res = JSObject()
                res.put("saved", true)
                res.put("path", "${dir.name ?: "folder"}/${file.name ?: filename}")
                call.resolve(res)
            } catch (e: SecurityException) {
                // Права на папку отозваны/протухли — как «папка не выбрана»
                val res = JSObject()
                res.put("saved", false)
                res.put("reason", "no-folder")
                call.resolve(res)
            } catch (e: Exception) {
                call.reject("Failed to save file: ${e.message}", e)
            }
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        executorService.execute {
            samLock.withLock {
                try {
                    samEmbedding?.close()
                    samEmbedding = null
                } catch (e: Exception) {}
                try {
                    samEncoderSession?.close()
                    samEncoderSession = null
                    samEncoderPath = null
                } catch (e: Exception) {}
                try {
                    samDecoderSession?.close()
                    samDecoderSession = null
                    samDecoderPath = null
                } catch (e: Exception) {}
            }
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

                    // Interpolate the raw model mask at this pixel
                    val p_y0 = wx0 * p_sub[y0Offset + x0] + wx1 * p_sub[y0Offset + x1]
                    val p_y1 = wx0 * p_sub[y1Offset + x0] + wx1 * p_sub[y1Offset + x1]
                    val rawMask = wy0 * p_y0 + wy1 * p_y1

                    // Apply linear transformation and clamp
                    var refinedAlpha = (aInterp * yVal + bInterp).coerceIn(0.0f, 1.0f)

                    // Gate the filter to the mask's transition band: on bright backgrounds the
                    // luminance-guided model leaks positive alpha outside the object, which shows
                    // up as a wide background-colored halo. Where the model is confident, trust it;
                    // in the band, harden the curve (smoothstep 0.25..0.75) to kill the faint fringe.
                    refinedAlpha = when {
                        rawMask < 0.2f -> 0.0f
                        rawMask > 0.95f -> 1.0f
                        else -> {
                            val t = ((refinedAlpha - 0.35f) / 0.5f).coerceIn(0.0f, 1.0f)
                            t * t * (3.0f - 2.0f * t)
                        }
                    }
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

/**
 * Post-processing edge cleanup for background-removed images.
 * Fixes: white/black halos, contaminated edge colors, jagged semi-transparent fringes.
 *
 * Pipeline: Smooth Alpha Erosion → Alpha Anti-Aliasing → Color Decontamination
 * Order matters: AA runs before decontamination so newly semi-transparent pixels get cleaned.
 */
object EdgeCleanup {

    /**
     * @param bitmap   The refined (premultiplied ARGB_8888) cutout whose alpha gets cleaned in place.
     * @param original The original opaque image of the same dimensions — the RGB source for all
     *                 color heuristics. `bitmap` itself is premultiplied, so getPixels() returns
     *                 RGB=(0,0,0) wherever alpha==0 (and quantized RGB at low alpha): estimating
     *                 the background color from it would collapse to black on any sheet color.
     */
    fun apply(bitmap: Bitmap, original: Bitmap) {
        val w = bitmap.width
        val h = bitmap.height

        val maskPixels = IntArray(w * h)
        bitmap.getPixels(maskPixels, 0, w, 0, 0, w, h)
        val alpha = IntArray(w * h) { (maskPixels[it] ushr 24) and 0xFF }

        // All RGB reads below use the original image, not the premultiplied cutout
        val pixels = IntArray(w * h)
        original.getPixels(pixels, 0, w, 0, 0, w, h)

        // Alpha floor: residue below ~11% opacity is invisible detail but reads as a dirty
        // veil / faint glow on dark backgrounds — drop it outright.
        for (i in 0 until w * h) {
            if (alpha[i] < 28) alpha[i] = 0
        }

        // Step 0: Background-pocket flood. Salient models mark background pockets between
        // touching objects (e.g. a coin next to a chest leg) as foreground, leaving opaque
        // patches of the sheet's background color. If the removed background is flat-colored,
        // flood from transparent pixels into color-matching neighbors and clear them.
        // Photographic (non-flat) backgrounds are detected and skipped.
        run {
            var bgCount = 0
            var rSum = 0L; var gSum = 0L; var bSum = 0L
            for (i in 0 until w * h) {
                if (alpha[i] < 10) {
                    val p = pixels[i]
                    rSum += (p shr 16) and 0xFF; gSum += (p shr 8) and 0xFF; bSum += p and 0xFF
                    bgCount++
                }
            }
            if (bgCount < w * h / 100) return@run
            val bgR = (rSum / bgCount).toInt()
            val bgG = (gSum / bgCount).toInt()
            val bgB = (bSum / bgCount).toInt()

            fun distToBg(i: Int): Int {
                val p = pixels[i]
                return maxOf(
                    Math.abs(((p shr 16) and 0xFF) - bgR),
                    Math.abs(((p shr 8) and 0xFF) - bgG),
                    Math.abs((p and 0xFF) - bgB)
                )
            }

            var devSum = 0L
            for (i in 0 until w * h) {
                if (alpha[i] < 10) devSum += distToBg(i)
            }
            val avgDev = (devSum / bgCount).toInt()
            if (avgDev > 12) return@run // background is not flat (photo) — too risky

            val tol = (maxOf(15, avgDev * 3)).coerceAtMost(28)
            val seen = BooleanArray(w * h)
            val queue = IntArray(w * h)
            var qTail = 0
            for (i in 0 until w * h) {
                if (alpha[i] < 10) { seen[i] = true; queue[qTail++] = i }
            }
            // Only cross semi-transparent pixels: opaque bg-colored pockets are handled by
            // the component pass below (with art-safety checks); flooding into opaque cores
            // would eat bright highlights whose peaks match the background color.
            fun visit(n: Int) {
                if (!seen[n]) {
                    seen[n] = true
                    if (alpha[n] < 240 && distToBg(n) <= tol) {
                        alpha[n] = 0
                        queue[qTail++] = n
                    }
                }
            }

            var qHead = 0
            while (qHead < qTail) {
                val i = queue[qHead++]
                val x = i % w
                if (x > 0) visit(i - 1)
                if (x < w - 1) visit(i + 1)
                if (i >= w) visit(i - w)
                if (i < w * (h - 1)) visit(i + w)
            }

            // Step 0.25: opaque background pockets. Candidates: bg-colored OR bright
            // low-saturation halo pixels. A candidate component is cleared only when
            // (a) its ring is partly semi-transparent (sealed pocket, not an interior
            // highlight), (b) it is small, and (c) it abuts dark object OUTLINES —
            // pockets border outlines with a sharp color step, while real highlights
            // fade smoothly into surrounding art.
            fun isCandidate(i: Int): Boolean {
                if (alpha[i] < 10) return false
                if (distToBg(i) <= tol) return true
                val p = pixels[i]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                val lum = 0.299f * r + 0.587f * g + 0.114f * b
                val mx = maxOf(r, g, b)
                val mn = minOf(r, g, b)
                return lum >= 232f && (mx - mn) <= 0.35f * mx
            }

            fun colorDelta(i: Int, j: Int): Int {
                val p = pixels[i]; val q = pixels[j]
                return maxOf(
                    Math.abs(((p shr 16) and 0xFF) - ((q shr 16) and 0xFF)),
                    Math.abs(((p shr 8) and 0xFF) - ((q shr 8) and 0xFF)),
                    Math.abs((p and 0xFF) - (q and 0xFF))
                )
            }

            val cap = (w * h) / 1000
            val cSeen = BooleanArray(w * h)
            val cQueue = IntArray(w * h)
            val component = IntArray(w * h)
            for (start in 0 until w * h) {
                if (cSeen[start] || !isCandidate(start)) continue
                var top = 0
                var count = 0
                var ringSoft = 0
                var ringTotal = 0
                var dSum = 0L
                var dCnt = 0
                cQueue[top++] = start
                cSeen[start] = true
                while (top > 0) {
                    val i = cQueue[--top]
                    component[count++] = i
                    val x = i % w
                    for (dir in 0 until 4) {
                        val n = when (dir) {
                            0 -> if (x > 0) i - 1 else -1
                            1 -> if (x < w - 1) i + 1 else -1
                            2 -> if (i >= w) i - w else -1
                            else -> if (i < w * (h - 1)) i + w else -1
                        }
                        if (n < 0) continue
                        if (isCandidate(n)) {
                            if (!cSeen[n]) { cSeen[n] = true; cQueue[top++] = n }
                        } else {
                            ringTotal++
                            if (alpha[n] < 240) {
                                ringSoft++
                            } else {
                                dSum += colorDelta(i, n)
                                dCnt++
                            }
                        }
                    }
                }
                if (count < cap && ringTotal > 0 &&
                    ringSoft.toFloat() / ringTotal >= 0.15f &&
                    dCnt > 0 && dSum.toFloat() / dCnt >= 45.0f) {
                    for (k in 0 until count) alpha[component[k]] = 0
                }
            }

            // Step 0.3: corridor sweep. RMBG keeps painted drop shadows squeezed
            // between two objects (chest shadow next to a coin) — semi-transparent
            // beige that reads as dirt in the gap. A corridor is any pixel within
            // Chebyshev 8 of TWO different solid components; open background around
            // a single object (a glow aura) is not a corridor. Semi pixels in
            // corridors that do not hug a silhouette are cleared; the ring adjacent
            // to solid keeps its AA transition.
            val corridor = BooleanArray(w * h)
            run {
                val solid = BooleanArray(w * h) { alpha[it] >= 240 }
                val lab = IntArray(w * h)
                var nlab = 0
                val compSize = ArrayList<Int>()
                val compStart = ArrayList<Int>()
                for (start in 0 until w * h) {
                    if (!solid[start] || lab[start] != 0) continue
                    nlab++
                    var top = 0
                    cQueue[top++] = start
                    lab[start] = nlab
                    var cnt = 0
                    while (top > 0) {
                        val i = cQueue[--top]
                        cnt++
                        val x = i % w
                        val y = i / w
                        for (dy in -1..1) {
                            val ny = y + dy
                            if (ny !in 0 until h) continue
                            for (dx in -1..1) {
                                val nx = x + dx
                                if (nx !in 0 until w) continue
                                val n = ny * w + nx
                                if (solid[n] && lab[n] == 0) { lab[n] = nlab; cQueue[top++] = n }
                            }
                        }
                    }
                    compSize.add(cnt)
                    compStart.add(start)
                }
                val rr = 8
                val nearCnt = IntArray(w * h)
                val stamp = IntArray(w * h)
                for (i in 0 until w * h) {
                    val c = lab[i]
                    if (c == 0 || compSize[c - 1] < 30) continue
                    val x = i % w
                    val y = i / w
                    for (dy in -rr..rr) {
                        val ny = y + dy
                        if (ny !in 0 until h) continue
                        for (dx in -rr..rr) {
                            val nx = x + dx
                            if (nx !in 0 until w) continue
                            val n = ny * w + nx
                            if (stamp[n] != c) { stamp[n] = c; nearCnt[n]++ }
                        }
                    }
                }
                for (i in 0 until w * h) {
                    if (nearCnt[i] < 2) continue
                    corridor[i] = true
                    if (alpha[i] in 1..239) {
                        val x = i % w
                        val y = i / w
                        var hugsSolid = false
                        loop@ for (dy in -1..1) {
                            val ny = y + dy
                            if (ny !in 0 until h) continue
                            for (dx in -1..1) {
                                val nx = x + dx
                                if (nx !in 0 until w) continue
                                if (solid[ny * w + nx]) { hugsSolid = true; break@loop }
                            }
                        }
                        if (!hugsSolid) alpha[i] = 0
                    }
                }
            }

            // Step 0.35: cut-in rescue. The model misreads bright highlights/glow near
            // object borders as background and the mask gate zeroes real object pixels
            // (coin rims, gold piles). On a flat background any pixel clearly NOT
            // bg-colored must belong to an object: restore its true alpha by
            // color-unmixing C = a*F + (1-a)*B against the nearest opaque anchor F.
            // Iterative so rescued cores become anchors for deeper pixels.
            // Anchors for RESURRECTION (alpha==0) are frozen to the pre-rescue
            // opaque pixels: rescued glow must never become its own anchor, or
            // the unmix estimate cascades to 1.0 and faint inter-object glow
            // (already cleared by the flood/pocket steps) comes back as a
            // smudge. A cleared pixel only returns when its color reads as
            // mostly-object (est >= 64) against TRUE object color. Gate-faded
            // pixels (alpha > 0) may use fresh anchors freely — that is
            // in-object repair, not resurrection.
            fun cutInRescue() {
                val opq0 = BooleanArray(w * h) { alpha[it] >= 250 }
                for (pass in 0 until 6) {
                    val prev = alpha.copyOf()
                    var changed = 0
                    for (y in 0 until h) {
                        for (x in 0 until w) {
                            val i = y * w + x
                            if (prev[i] >= 240 || distToBg(i) <= 45) continue
                            // in corridors between objects only unmistakably vivid
                            // object color may be repaired: painted drop shadows
                            // peak at ~dist 120 on this class of art, real bitten
                            // gold/art sits at 140+.
                            if (corridor[i] && distToBg(i) < 130) continue
                            val resurrect = prev[i] == 0
                            val rad = if (resurrect) 5 + 2 * pass else 5
                            var bestD = Int.MAX_VALUE
                            var bestI = -1
                            for (dy in -rad..rad) {
                                val ny = y + dy
                                if (ny !in 0 until h) continue
                                for (dx in -rad..rad) {
                                    val nx = x + dx
                                    if (nx !in 0 until w) continue
                                    val n = ny * w + nx
                                    val isAnchor = if (resurrect) opq0[n] else prev[n] >= 250
                                    if (isAnchor) {
                                        val d = dx * dx + dy * dy
                                        if (d < bestD) { bestD = d; bestI = n }
                                    }
                                }
                            }
                            if (bestI < 0) continue
                            val f = pixels[bestI]
                            val c = pixels[i]
                            val uR = (((f shr 16) and 0xFF) - bgR).toFloat()
                            val uG = (((f shr 8) and 0xFF) - bgG).toFloat()
                            val uB = ((f and 0xFF) - bgB).toFloat()
                            val vR = (((c shr 16) and 0xFF) - bgR).toFloat()
                            val vG = (((c shr 8) and 0xFF) - bgG).toFloat()
                            val vB = ((c and 0xFF) - bgB).toFloat()
                            val uu = uR * uR + uG * uG + uB * uB
                            if (uu < 1f) continue
                            val aEst = (vR * uR + vG * uG + vB * uB) / uu
                            val est = if (aEst >= 0.92f) 255
                                      else Math.round(aEst.coerceAtLeast(0f) * 255f)
                            if (est > alpha[i] && (!resurrect || est >= 64)) {
                                alpha[i] = est; changed++
                            }
                        }
                    }
                    if (changed == 0) return
                }
            }
            cutInRescue()

            // Step 0.4: fill small low-alpha holes with smooth boundaries — the model
            // misreads the brightest highlight cores as background, leaving pits inside
            // objects. Real holes (shackles, keyholes) abut dark outlines (high contrast)
            // or large transparent areas and are left alone.
            java.util.Arrays.fill(cSeen, false)
            for (start in 0 until w * h) {
                if (cSeen[start] || alpha[start] >= 128) continue
                var top = 0
                var count = 0
                var ringOpaque = 0
                var ringTotal = 0
                var dSum = 0L
                var dCnt = 0
                var overflow = false
                cQueue[top++] = start
                cSeen[start] = true
                while (top > 0) {
                    val i = cQueue[--top]
                    if (count < component.size) component[count] = i
                    count++
                    if (count >= cap) overflow = true
                    val x = i % w
                    for (dir in 0 until 4) {
                        val n = when (dir) {
                            0 -> if (x > 0) i - 1 else -1
                            1 -> if (x < w - 1) i + 1 else -1
                            2 -> if (i >= w) i - w else -1
                            else -> if (i < w * (h - 1)) i + w else -1
                        }
                        if (n < 0) { ringTotal++; continue }
                        if (alpha[n] < 128) {
                            if (!cSeen[n]) { cSeen[n] = true; cQueue[top++] = n }
                        } else {
                            ringTotal++
                            if (alpha[n] >= 240) {
                                ringOpaque++
                                dSum += colorDelta(i, n)
                                dCnt++
                            }
                        }
                    }
                }
                if (!overflow && count < cap && ringTotal > 0 &&
                    ringOpaque.toFloat() / ringTotal >= 0.6f &&
                    dCnt > 0 && dSum.toFloat() / dCnt < 30.0f) {
                    for (k in 0 until count) alpha[component[k]] = 255
                }
            }

            // Step 0.46: second rescue pass — hole-fill created fresh opaque anchors.
            cutInRescue()

            // Step 0.47: interior pale components → opaque. A pale solid region
            // (scroll paper, star highlight, gem facet) is chromatically ambiguous
            // with a partial white-blend, so unmixing underestimates its alpha and
            // the gate leaves it translucent. Decide by geometry instead of size:
            // a component whose ring is mostly OPAQUE art sits inside an object
            // and becomes solid; a ring dominated by transparency is a glow
            // field / aura over background and keeps its soft alpha. Only
            // gate-faded pixels (alpha >= 10) qualify — fully cleared
            // inter-object glow is never revived.
            run {
                fun nearBgLike(i: Int): Boolean {
                    val x = i % w
                    val y = i / w
                    for (dy in -1..1) {
                        val ny = y + dy
                        if (ny !in 0 until h) continue
                        for (dx in -1..1) {
                            val nx = x + dx
                            if (nx !in 0 until w) continue
                            if (distToBg(ny * w + nx) <= 14) return true
                        }
                    }
                    return false
                }
                // dist > 22 (not 45): pale gem facets and pastel highlights sit in
                // the 22..45 band and are solid art when nothing bg-like is adjacent.
                fun isInteriorCand(i: Int): Boolean =
                    alpha[i] in 10..239 && !corridor[i] && distToBg(i) > 22 && !nearBgLike(i)

                java.util.Arrays.fill(cSeen, false)
                for (start in 0 until w * h) {
                    if (cSeen[start] || !isInteriorCand(start)) continue
                    var top = 0
                    var count = 0
                    var ringOpq = 0
                    var ringTrans = 0
                    cQueue[top++] = start
                    cSeen[start] = true
                    while (top > 0) {
                        val i = cQueue[--top]
                        component[count++] = i
                        val x = i % w
                        for (dir in 0 until 4) {
                            val n = when (dir) {
                                0 -> if (x > 0) i - 1 else -1
                                1 -> if (x < w - 1) i + 1 else -1
                                2 -> if (i >= w) i - w else -1
                                else -> if (i < w * (h - 1)) i + w else -1
                            }
                            if (n < 0) { ringTrans++; continue }
                            if (isInteriorCand(n)) {
                                if (!cSeen[n]) { cSeen[n] = true; cQueue[top++] = n }
                            } else {
                                if (alpha[n] >= 240) ringOpq++
                                else if (alpha[n] < 10) ringTrans++
                            }
                        }
                    }
                    if (ringOpq + ringTrans > 0 &&
                        ringOpq.toFloat() / (ringOpq + ringTrans) >= 0.55f) {
                        for (k in 0 until count) alpha[component[k]] = 255
                    }
                }
            }

            // Step 0.48: enclosed hesitation specks → opaque. Clusters where the
            // model was UNSURE (alpha 32..239) fully ringed by opaque art are
            // highlight cores inside objects (gem facets) — fill them. Real
            // see-through holes (lock shackle, keyholes) are kept: the model
            // clears those confidently (alpha 0), and such pixels are excluded
            // from the cluster, breaking the opaque ring.
            run {
                val spCap = (w * h) / 3000
                java.util.Arrays.fill(cSeen, false)
                for (start in 0 until w * h) {
                    if (cSeen[start] || alpha[start] < 32 || alpha[start] >= 240 || corridor[start]) continue
                    var top = 0
                    var count = 0
                    var ringOpq = 0
                    var ringTotal = 0
                    var overflow = false
                    cQueue[top++] = start
                    cSeen[start] = true
                    while (top > 0) {
                        val i = cQueue[--top]
                        if (count < component.size) component[count] = i
                        count++
                        if (count >= spCap) overflow = true
                        val x = i % w
                        for (dir in 0 until 4) {
                            val n = when (dir) {
                                0 -> if (x > 0) i - 1 else -1
                                1 -> if (x < w - 1) i + 1 else -1
                                2 -> if (i >= w) i - w else -1
                                else -> if (i < w * (h - 1)) i + w else -1
                            }
                            if (n < 0) { ringTotal++; continue }
                            if (alpha[n] in 32..239 && !corridor[n]) {
                                if (!cSeen[n]) { cSeen[n] = true; cQueue[top++] = n }
                            } else {
                                ringTotal++
                                if (alpha[n] >= 240) ringOpq++
                            }
                        }
                    }
                    if (!overflow && count < spCap && ringTotal > 0 &&
                        ringOpq.toFloat() / ringTotal >= 0.6f) {
                        for (k in 0 until count) alpha[component[k]] = 255
                    }
                }
            }
        }

        // Step 0.5: Despeckle — drop tiny, weak (semi-transparent) islands: leftover
        // specks of mask noise around objects. Small but OPAQUE details (sparkles,
        // dots that are real art) are kept via the max-alpha condition.
        run {
            val minArea = maxOf(24, (w * h) / 40000)
            val labelSeen = BooleanArray(w * h)
            val stack = IntArray(w * h)
            val component = IntArray(w * h)
            for (start in 0 until w * h) {
                if (labelSeen[start] || alpha[start] < 10) continue
                var top = 0
                var count = 0
                var maxA = 0
                stack[top++] = start
                labelSeen[start] = true
                while (top > 0) {
                    val i = stack[--top]
                    component[count++] = i
                    if (alpha[i] > maxA) maxA = alpha[i]
                    val x = i % w
                    if (x > 0 && !labelSeen[i - 1] && alpha[i - 1] >= 10) { labelSeen[i - 1] = true; stack[top++] = i - 1 }
                    if (x < w - 1 && !labelSeen[i + 1] && alpha[i + 1] >= 10) { labelSeen[i + 1] = true; stack[top++] = i + 1 }
                    if (i >= w && !labelSeen[i - w] && alpha[i - w] >= 10) { labelSeen[i - w] = true; stack[top++] = i - w }
                    if (i < w * (h - 1) && !labelSeen[i + w] && alpha[i + w] >= 10) { labelSeen[i + w] = true; stack[top++] = i + w }
                }
                if (count < minArea && maxA < 160) {
                    for (k in 0 until count) alpha[component[k]] = 0
                }
            }
        }

        // Step 1: Smooth Alpha Erosion — only thick edges; thin structures (hair/wires) are preserved
        val erodedAlpha = IntArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                val i = y * w + x
                val a = alpha[i]
                if (a == 0) { erodedAlpha[i] = 0; continue }
                var nearT = 0; var total = 0
                for (dy in -1..1) { for (dx in -1..1) {
                    if (dx == 0 && dy == 0) continue
                    val nx = x + dx; val ny = y + dy
                    if (nx in 0 until w && ny in 0 until h) {
                        total++
                        if (alpha[ny * w + nx] == 0) nearT++
                    }
                }}
                val opaqueCount = total - nearT
                erodedAlpha[i] = if (nearT > 0 && opaqueCount >= 3) {
                    (a * (1.0f - nearT.toFloat() / total.toFloat() * 0.5f)).toInt().coerceIn(0, 255)
                } else a
            }
        }

        // Step 2: Alpha Anti-Aliasing — smooth jagged edges
        val aaAlpha = erodedAlpha.copyOf()
        for (y in 1 until h - 1) { for (x in 1 until w - 1) {
            val i = y * w + x; val a = erodedAlpha[i]
            var isEdge = a in 1..254
            if (!isEdge && a == 255) {
                isEdge = erodedAlpha[i-1] < 255 || erodedAlpha[i+1] < 255 ||
                        erodedAlpha[i-w] < 255 || erodedAlpha[i+w] < 255
            }
            if (!isEdge) continue
            var s = 0; var wt = 0
            for (dy in -1..1) { for (dx in -1..1) {
                val cw = if (dx == 0 && dy == 0) 4 else 1
                s += erodedAlpha[(y+dy)*w+(x+dx)] * cw; wt += cw
            }}
            aaAlpha[i] = (s.toFloat() / wt.toFloat()).toInt().coerceAtMost(a).coerceIn(0, 255)
        }}

        // Step 2.5: Anti-alias feather — removes the staircase ("лесенка"). The
        // staircase is a property of edge CURVATURE, not luminance contrast: the
        // low-res model mask rasterizes curved / near-diagonal boundaries (medals,
        // coins, star tips) into visible steps, while axis-aligned edges (chests)
        // stay clean. A mild global 5-tap gaussian in a thin band around the boundary
        // smooths the curves; straight edges have no staircase and stay essentially
        // unchanged. Deep interior/exterior pixels are left exact.
        run {
            val af = FloatArray(w * h) { aaAlpha[it].toFloat() }
            val tmp = FloatArray(w * h)
            for (y in 0 until h) { for (x in 0 until w) {
                val ym2 = (y - 2).coerceIn(0, h - 1); val ym1 = (y - 1).coerceIn(0, h - 1)
                val yp1 = (y + 1).coerceIn(0, h - 1); val yp2 = (y + 2).coerceIn(0, h - 1)
                tmp[y * w + x] = (af[ym2*w+x] + 4f*af[ym1*w+x] + 6f*af[y*w+x] + 4f*af[yp1*w+x] + af[yp2*w+x]) / 16f
            }}
            val ab = FloatArray(w * h)
            for (y in 0 until h) { val row = y * w; for (x in 0 until w) {
                val xm2 = (x - 2).coerceIn(0, w - 1); val xm1 = (x - 1).coerceIn(0, w - 1)
                val xp1 = (x + 1).coerceIn(0, w - 1); val xp2 = (x + 2).coerceIn(0, w - 1)
                ab[row + x] = (tmp[row+xm2] + 4f*tmp[row+xm1] + 6f*tmp[row+x] + 4f*tmp[row+xp1] + tmp[row+xp2]) / 16f
            }}
            // limit to a 2px band around the boundary; leave deep interior/exterior exact
            val edge = BooleanArray(w * h) { aaAlpha[it] in 5..250 }
            for (y in 0 until h) { for (x in 0 until w) {
                var any = false
                loop@ for (dy in -2..2) { for (dx in -2..2) {
                    val nx = x + dx; val ny = y + dy
                    if (nx in 0 until w && ny in 0 until h && edge[ny * w + nx]) { any = true; break@loop }
                }}
                if (!any) continue
                val i = y * w + x
                aaAlpha[i] = ab[i].toInt().coerceIn(0, 255)
            }}
        }

        for (i in 0 until w * h) pixels[i] = (aaAlpha[i] shl 24) or (pixels[i] and 0x00FFFFFF)

        // Step 3: Color Decontamination — replace background color bleed on semi-transparent edges
        val snap = pixels.copyOf()
        for (y in 0 until h) { for (x in 0 until w) {
            val i = y * w + x; val a = aaAlpha[i]
            if (a <= 0 || a >= 240) continue
            var nearBg = false
            run outer@{ for (dy in -3..3) { for (dx in -3..3) {
                val nx = x+dx; val ny = y+dy
                if (nx in 0 until w && ny in 0 until h && aaAlpha[ny*w+nx] == 0) { nearBg = true; return@outer }
            }}}
            if (!nearBg) continue
            var bestD = Int.MAX_VALUE; var bestI = -1
            for (dy in -5..5) { for (dx in -5..5) {
                if (dx == 0 && dy == 0) continue
                val nx = x+dx; val ny = y+dy
                if (nx in 0 until w && ny in 0 until h && aaAlpha[ny*w+nx] >= 240) {
                    val d = dx*dx + dy*dy
                    if (d < bestD) { bestD = d; bestI = ny*w+nx }
                }
            }}
            if (bestI != -1) pixels[i] = (a shl 24) or (snap[bestI] and 0x00FFFFFF)
        }}

        bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
    }
}
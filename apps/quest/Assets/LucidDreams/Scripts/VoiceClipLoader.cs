using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace LucidDreams
{
    // Turns a bundle's voice.m4a (AAC) into an AudioClip, so Unity can play it as a positioned sound in the room.
    // On the Quest it decodes with Android's own MediaExtractor + MediaCodec (Unity's runtime loader can't open AAC
    // there), a few buffers per frame so loading never stalls rendering. Elsewhere Unity's loader handles it.
    public static class VoiceClipLoader
    {
        public static IEnumerator Load(string url, Action<AudioClip> done, Action<string> failed)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            string path = null;
            if (url.StartsWith("file://")) path = new Uri(url).LocalPath;
            else
            {
                // From the bridge: keep a local copy for the decoder.
                path = Path.Combine(Application.temporaryCachePath, $"voice-{Mathf.Abs(url.GetHashCode())}{Path.GetExtension(url)}");
                using var request = UnityWebRequest.Get(url);
                request.downloadHandler = new DownloadHandlerFile(path);
                yield return request.SendWebRequest();
                if (request.result != UnityWebRequest.Result.Success) { failed(request.error); yield break; }
            }
            yield return DecodeAndroid(path, done, failed);
#elif UNITY_EDITOR_OSX
            // Unity's audio engine can't open AAC at runtime; on a Mac the system converter turns it into WAV first.
            string source = url.StartsWith("file://") ? new Uri(url).LocalPath : null;
            if (source == null)
            {
                source = Path.Combine(Application.temporaryCachePath, $"voice-{Mathf.Abs(url.GetHashCode())}{Path.GetExtension(url)}");
                using var download = UnityWebRequest.Get(url);
                download.downloadHandler = new DownloadHandlerFile(source);
                yield return download.SendWebRequest();
                if (download.result != UnityWebRequest.Result.Success) { failed(download.error); yield break; }
            }
            string wav = Path.Combine(Application.temporaryCachePath, $"voice-{Mathf.Abs(source.GetHashCode())}.wav");
            using (var convert = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("/usr/bin/afconvert",
                       $"-f WAVE -d LEI16 \"{source}\" \"{wav}\"") { UseShellExecute = false, CreateNoWindow = true }))
            {
                while (!convert.HasExited) yield return null;
                if (convert.ExitCode != 0) { failed("afconvert couldn't read the voice track"); yield break; }
            }
            yield return LoadWith(new Uri(wav).AbsoluteUri, AudioType.WAV, done, failed);
#else
            yield return LoadWith(url, AudioType.UNKNOWN, done, failed);
#endif
        }

        static IEnumerator LoadWith(string url, AudioType type, Action<AudioClip> done, Action<string> failed)
        {
            using var request = UnityWebRequestMultimedia.GetAudioClip(url, type);
            ((DownloadHandlerAudioClip)request.downloadHandler).streamAudio = false;
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success) { failed(request.error); yield break; }
            AudioClip clip = null;
            try { clip = DownloadHandlerAudioClip.GetContent(request); }
            catch (Exception e) { failed(e.Message); yield break; }
            if (clip != null && clip.length > 0f) done(clip);
            else failed("this platform can't decode the voice track");
        }

#if UNITY_ANDROID && !UNITY_EDITOR
        const int BuffersPerFrame = 24;
        const int EndOfStream = 4; // MediaCodec.BUFFER_FLAG_END_OF_STREAM
        const int FormatChanged = -2; // MediaCodec.INFO_OUTPUT_FORMAT_CHANGED

        static IEnumerator DecodeAndroid(string path, Action<AudioClip> done, Action<string> failed)
        {
            AndroidJavaObject extractor = null, codec = null, info = null, format = null;
            var samples = new List<float>(1 << 18);
            int rate = 44100, channels = 1;
            string error = null;
            try
            {
                extractor = new AndroidJavaObject("android.media.MediaExtractor");
                extractor.Call("setDataSource", path);
                int tracks = extractor.Call<int>("getTrackCount");
                string mime = null;
                for (int i = 0; i < tracks && mime == null; i++)
                {
                    var f = extractor.Call<AndroidJavaObject>("getTrackFormat", i);
                    string m = f.Call<string>("getString", "mime");
                    if (m != null && m.StartsWith("audio/"))
                    {
                        extractor.Call("selectTrack", i);
                        format = f;
                        mime = m;
                    }
                    else f.Dispose();
                }
                if (mime == null) throw new Exception("no audio track");
                rate = format.Call<int>("getInteger", "sample-rate");
                channels = format.Call<int>("getInteger", "channel-count");
                using (var codecs = new AndroidJavaClass("android.media.MediaCodec"))
                    codec = codecs.CallStatic<AndroidJavaObject>("createDecoderByType", mime);
                codec.Call("configure", format, null, null, 0);
                codec.Call("start");
                info = new AndroidJavaObject("android.media.MediaCodec$BufferInfo");
            }
            catch (Exception e) { error = e.Message; }
            if (error != null)
            {
                Release(extractor, codec, info, format);
                failed($"voice decoder: {error}");
                yield break;
            }

            bool inputDone = false, outputDone = false;
            while (!outputDone && error == null)
            {
                try
                {
                    for (int n = 0; n < BuffersPerFrame && !outputDone; n++)
                    {
                        if (!inputDone)
                        {
                            int inIndex = codec.Call<int>("dequeueInputBuffer", 0L);
                            if (inIndex >= 0)
                            {
                                using var input = codec.Call<AndroidJavaObject>("getInputBuffer", inIndex);
                                int size = extractor.Call<int>("readSampleData", input, 0);
                                if (size < 0)
                                {
                                    codec.Call("queueInputBuffer", inIndex, 0, 0, 0L, EndOfStream);
                                    inputDone = true;
                                }
                                else
                                {
                                    codec.Call("queueInputBuffer", inIndex, 0, size, extractor.Call<long>("getSampleTime"), 0);
                                    extractor.Call<bool>("advance");
                                }
                            }
                        }

                        int outIndex = codec.Call<int>("dequeueOutputBuffer", info, 1000L);
                        if (outIndex == FormatChanged)
                        {
                            using var outFormat = codec.Call<AndroidJavaObject>("getOutputFormat");
                            rate = outFormat.Call<int>("getInteger", "sample-rate");
                            channels = outFormat.Call<int>("getInteger", "channel-count");
                        }
                        else if (outIndex >= 0)
                        {
                            int size = info.Get<int>("size");
                            if (size > 0)
                            {
                                using var output = codec.Call<AndroidJavaObject>("getOutputBuffer", outIndex);
                                output.Call<AndroidJavaObject>("position", info.Get<int>("offset")).Dispose();
                                AppendPcm16(output, size, samples);
                            }
                            codec.Call("releaseOutputBuffer", outIndex, false);
                            if ((info.Get<int>("flags") & EndOfStream) != 0) outputDone = true;
                        }
                    }
                }
                catch (Exception e) { error = e.Message; }
                yield return null;
            }
            Release(extractor, codec, info, format);
            if (error != null || samples.Count == 0)
            {
                failed($"voice decoder: {error ?? "no audio decoded"}");
                yield break;
            }
            var clip = AudioClip.Create("voice", samples.Count / channels, channels, rate, false);
            clip.SetData(samples.ToArray(), 0);
            done(clip);
        }

        // Copies a direct ByteBuffer of 16-bit PCM out through JNI (a managed byte[] argument would only fill a copy).
        static void AppendPcm16(AndroidJavaObject buffer, int size, List<float> samples)
        {
            IntPtr array = AndroidJNI.NewSByteArray(size);
            try
            {
                IntPtr get = AndroidJNIHelper.GetMethodID(buffer.GetRawClass(), "get", "([B)Ljava/nio/ByteBuffer;");
                IntPtr self = AndroidJNI.CallObjectMethod(buffer.GetRawObject(), get, new[] { new jvalue { l = array } });
                AndroidJNI.DeleteLocalRef(self);
                var bytes = AndroidJNI.FromSByteArray(array);
                for (int i = 0; i + 1 < bytes.Length; i += 2)
                    samples.Add((short)((byte)bytes[i] | ((byte)bytes[i + 1] << 8)) / 32768f);
            }
            finally { AndroidJNI.DeleteLocalRef(array); }
        }

        static void Release(AndroidJavaObject extractor, AndroidJavaObject codec, AndroidJavaObject info, AndroidJavaObject format)
        {
            try { codec?.Call("stop"); } catch { }
            try { codec?.Call("release"); } catch { }
            try { extractor?.Call("release"); } catch { }
            codec?.Dispose();
            extractor?.Dispose();
            info?.Dispose();
            format?.Dispose();
        }
#endif
    }
}

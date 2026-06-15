# HEVC Muxing & Browser Playback Architecture Guide

This document explains the video playback architecture of the Comma 360 Panorama Viewer, detailing the local (browser-side) and remote (server-side) muxing operations, developer configuration modes, and browser compatibility details.

---

## 1. Muxing Overview

Camera feeds on comma three devices are recorded as raw, containerless H.265 (HEVC) elementary streams (`.hevc`). HTML5 `<video>` elements cannot play raw streams directly; they require the video packets to be wrapped in a container format (like MP4) containing timestamp and frame boundary metadata.

This application uses two methods to wrap these streams:

| Muxing Type | Processing Location | Media Pipeline | Pros | Cons |
| :--- | :--- | :--- | :--- | :--- |
| **Local Muxing** | **Client (Browser)** | Raw `.hevc` stream $\rightarrow$ `JMuxer` (MSE) $\rightarrow$ Fragmented MP4 in-memory $\rightarrow$ `<video>` | Very low server CPU overhead, offline-capable | Higher client CPU/GPU decoding load, requires browser HEVC MSE support |
| **Remote Muxing** | **Server (Python)** | Raw `.hevc` file $\rightarrow$ `ffmpeg` subprocess $\rightarrow$ Fragmented MP4 over HTTP $\rightarrow$ `<video>` | 100% browser compatibility, low client overhead | High server CPU/memory overhead during transmuxing |

---

## 2. Playback Pipeline Details

### Local Muxing (JMuxer + MSE)
1. **Fetch & Segment**: The client downloads the `.hevc` file as a stream via fetch reader in [app.js](file:///config/projects/comma-vid-viewer/app.js).
2. **Backpressure Pacing**: To prevent memory overflow and decoder stalling, a pacing loop monitors `video.buffered`. It keeps a forward buffer of exactly **5 seconds** ahead of the current playhead, sleeping the stream reader when full.
3. **NAL Slicing**: Raw bytes are accumulated and sliced strictly on H.265 NAL unit boundaries (`0x000001` or `0x00000001`).
4. **Remuxing**: Complete NALs are fed into `JMuxer` which packages them into fragmented MP4 (fMP4) boxes (`moof` and `mdat`) using a `1000ms` segment size.
5. **Buffer Append**: The remuxed bytes are pushed into the MediaSource's `SourceBuffer`. The queue is automatically drained on the buffer's `updateend` event in [jmuxer.min.js](file:///config/projects/comma-vid-viewer/js/jmuxer.min.js).

### Remote Muxing (FFmpeg Server Transmuxing)
1. **Request**: The client requests the `.mp4` route of a camera feed.
2. **On-the-fly Transmux**: The python backend [server.py](file:///config/projects/comma-vid-viewer/server.py) executes a lightweight `ffmpeg` subprocess using pipe streaming:
   ```bash
   ffmpeg -y -i <camera>.hevc -c:v copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1
   ```
   Because `-c:v copy` is used, the video packets are not re-encoded (saving CPU cycles); they are simply copied into a standard fragmented MP4 container.
3. **Caching**: The output is cached in-memory and saved to disk to prevent redundant transmux operations.

---

## 3. Developer Muxing Modes

Accessible by double-clicking the green **ONLINE** status indicator or pressing the `D` key, the **HEVC Muxing Mode** dropdown in [index.html](file:///config/projects/comma-vid-viewer/index.html) offers three modes:

1. **Auto (Fallback)** *(Default)*:
   * The app checks if the browser natively supports HEVC MSE. If it does, it attempts local muxing.
   * If local muxing is attempted but the video element's `readyState` remains stuck at `0` (HAVE_NOTHING) for `1.5s` (often indicating a hardware decoding configuration failure), the player destroys `JMuxer` and falls back to remote `.mp4`.
   * **Persistence**: On fallback, the user agent is written to `localStorage` (`comma_360_hevc_failed_ua`). Future visits automatically bypass the `1.5s` test and request remote muxing immediately.
2. **Force Local Muxing**:
   * Bypasses the native support check and the `1.5s` fallback timeout. 
   * Useful for debugging client-side video decode issues or checking console logs without the player swapping out the media element.
3. **Force Remote Muxing**:
   * Always bypasses local muxing and requests transmuxed `.mp4` streams directly from the server.

> [!TIP]
> Changing the **HEVC Muxing Mode** dropdown dynamically reloads all active camera feeds and restores your timeline playhead to the exact second you were viewing. Changing back to `Auto` or `Force Local` automatically clears the saved failure flag from `localStorage`.

---

## 4. Browser Compatibility Analysis

### Why Local Muxing Fails on Chrome 149 (Windows / Android)
* **Windows Chrome 149**: 
  Google Chrome on Windows relies entirely on OS-level hardware decoding API support for H.265. Even if GPU acceleration is active in Chrome settings, Windows requires the user to install the paid **"HEVC Video Extensions"** ($0.99) from the Microsoft Store. Without this codec package, Chrome will report that HEVC is unsupported, or its MSE initialization pipeline will stall on decode startup (stuck at `readyState = 0`).
* **Android Chrome**:
  Android devices contain hardware H.265 decoders, but Chrome's sandboxed rendering engine disables or hides access to these decoders in its MediaSource implementation on most mobile SOCs to save battery or avoid licensing complications.
* **Linux Chrome**:
  Proprietary codecs (like HEVC/H.265) are disabled by default in standard Linux Chrome builds unless built with specific proprietary flags or run with complex system GPU decoding layers configured.

### Why Local Muxing Works on Firefox
* **Firefox Support**:
  Firefox integrates system-level and software fallbacks for HEVC playback natively. It can successfully interface with standard Windows graphics drivers (or macOS frameworks) to access hardware decoders without requiring third-party licensed app packages from the Microsoft Store.
* **Optimized Playback**:
  By using a larger `1000ms` fragment size and a paced `5s` forward buffer in this app, Firefox can parse, decode, and play the HEVC frames smoothly without timeline stutters or buffer quota issues.

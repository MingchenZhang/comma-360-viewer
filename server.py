# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pycapnp",
#     "zstandard",
# ]
# ///

import os
import sys
import json
import argparse
import tempfile
import subprocess
import urllib.parse
import threading
import datetime
import shutil
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import capnp
import zstandard

# Locate ffmpeg and ffprobe binaries
FFMPEG_PATH = "ffmpeg"
FFPROBE_PATH = "ffprobe"

def find_binary(name):
    # 1. Try standard shutil.which (searches current PATH)
    path = shutil.which(name)
    if path:
        return path
        
    # 2. Try running shell lookup (may resolve bash aliases or shell configurations)
    try:
        res = subprocess.run(f"which {name}", shell=True, capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
        
    # 3. Check current python virtual environment's bin directory
    try:
        py_bin_dir = os.path.dirname(sys.executable)
        py_bin_path = os.path.join(py_bin_dir, name)
        if os.path.exists(py_bin_path) and os.access(py_bin_path, os.X_OK):
            return py_bin_path
    except Exception:
        pass
        
    # 4. Check common binary paths directly (including comma venv path)
    for p in [f"/usr/bin/{name}", f"/usr/local/bin/{name}", f"/usr/local/venv/bin/{name}"]:
        if os.path.exists(p) and os.access(p, os.X_OK):
            return p
            
    return None

def init_ffmpeg():
    global FFMPEG_PATH, FFPROBE_PATH
    
    # Attempt to locate ffmpeg / ffprobe locally
    f_path = find_binary("ffmpeg")
    p_path = find_binary("ffprobe")
            
    if f_path:
        FFMPEG_PATH = f_path
    if p_path:
        FFPROBE_PATH = p_path
        
    print(f"[FFmpeg] Using ffmpeg binary: {FFMPEG_PATH}")
    print(f"[FFmpeg] Using ffprobe binary: {FFPROBE_PATH}")

init_ffmpeg()

# Global schemas and telemetry cache
log_capnp = None
telemetry_cache = {}
telemetry_lock = threading.Lock()
route_time_cache = {}
route_time_lock = threading.Lock()

PORT = 8080
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = STATIC_DIR
CACHE_DIR = os.path.join(STATIC_DIR, ".cache")

def load_schemas():
    global log_capnp
    try:
        schema_path = os.path.join(STATIC_DIR, "cereal_schemas/log.capnp")
        if os.path.exists(schema_path):
            log_capnp = capnp.load(schema_path)
            print("[Schemas] Loaded log.capnp successfully")
        else:
            print("[Schemas] Warning: cereal_schemas/log.capnp not found")
    except Exception as e:
        print(f"[Schemas] Error loading schemas: {e}")

# Global lock dictionary to prevent concurrent writes to the same file
transmux_locks = {}
locks_lock = threading.Lock()

def get_transmux_lock(filepath):
    with locks_lock:
        if filepath not in transmux_locks:
            transmux_locks[filepath] = threading.Lock()
        return transmux_locks[filepath]

# In-memory cache for transmuxed MP4 data
mp4_cache = {}
cache_lock = threading.Lock()

def cache_mp4_data(key, data):
    with cache_lock:
        # Keep cache capped at 6 files max to limit memory footprint (~440MB max)
        if len(mp4_cache) >= 6:
            oldest_key = next(iter(mp4_cache))
            del mp4_cache[oldest_key]
            print(f"[Memory Cache] Evicted: {oldest_key}")
        mp4_cache[key] = data

def get_cache_path(filepath):
    # Map the requested file path (relative to WORKSPACE) to a path under CACHE_DIR
    rel_path = os.path.relpath(filepath, WORKSPACE)
    if rel_path.startswith("..") or os.path.isabs(rel_path):
        import hashlib
        h = hashlib.md5(filepath.encode('utf-8')).hexdigest()
        return os.path.join(CACHE_DIR, h)
    return os.path.join(CACHE_DIR, rel_path)

def save_cache_to_disk(filepath, data):
    def save_worker():
        try:
            cache_path = get_cache_path(filepath)
            dir_name = os.path.dirname(cache_path)
            os.makedirs(dir_name, exist_ok=True)
            
            temp_fd, temp_path = tempfile.mkstemp(dir=dir_name)
            try:
                with os.fdopen(temp_fd, 'wb') as f:
                    f.write(data)
                os.replace(temp_path, cache_path)
                print(f"[Disk Cache] Saved: {cache_path}")
            except Exception as e:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                print(f"[Disk Cache] Error saving to disk: {e}")
        except Exception as e:
            print(f"[Disk Cache] Thread error: {e}")

    threading.Thread(target=save_worker, daemon=True).start()

class CommaVidRequestHandler(SimpleHTTPRequestHandler):
    def serve_file_from_cache(self, cache_path, content_type):
        try:
            with open(cache_path, 'rb') as f:
                data = f.read()
            self.serve_bytes(data, content_type=content_type)
        except Exception as e:
            print(f"[Server] Error serving from cache: {e}")
            self.send_error(500, "Error serving from cache")

    def translate_path(self, path):
        # Decode path
        parsed_url = urllib.parse.urlparse(path)
        url_path = parsed_url.path
        
        # Strip leading slash
        if url_path.startswith('/'):
            url_path = url_path[1:]
            
        # If root or index.html is requested, serve index.html from STATIC_DIR
        if url_path == "" or url_path == "index.html":
            return os.path.join(STATIC_DIR, "index.html")
            
        # Check if requested file exists in static files directory (e.g. index.html, styles.css, app.js)
        static_file_path = os.path.join(STATIC_DIR, url_path)
        if os.path.exists(static_file_path) and not os.path.isdir(static_file_path):
            return static_file_path
            
        # Also support subdirectories under STATIC_DIR (like cereal_schemas)
        if url_path.startswith('cereal_schemas/'):
            return static_file_path
            
        # Otherwise, resolve relative to the video data directory (WORKSPACE)
        return os.path.join(WORKSPACE, url_path)

    def end_headers(self):
        try:
            filepath = self.translate_path(self.path)
            has_cache_control = any(b'cache-control' in h.lower() for h in self._headers_buffer)
            if not has_cache_control:
                # Permanently cache static vendor libraries in /js/ directory
                if "/js/" in self.path or "/js/" in filepath:
                    self.send_header('Cache-Control', 'public, max-age=31536000')
                elif filepath.endswith(('.html', '.js', '.css', '.json')) or self.path in ['/', '/index.html', '/app.js', '/styles.css']:
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                    self.send_header('Pragma', 'no-cache')
                    self.send_header('Expires', '0')
        except Exception:
            pass
        super().end_headers()

    def do_GET(self):
        # Decode path
        parsed_url = urllib.parse.urlparse(self.path)
        
        # Intercept /routes.json request
        if parsed_url.path in ['/routes.json', 'routes.json']:
            self.send_routes_json()
            return

        # Intercept telemetry requests
        if parsed_url.path.startswith('/telemetry/') and parsed_url.path.endswith('.json'):
            route_name = parsed_url.path.split('/telemetry/')[1].rsplit('.json', 1)[0]
            self.send_telemetry_json(route_name)
            return

        filepath = self.translate_path(parsed_url.path)
        
        # Intercept qcamera.m4a requests
        if filepath.endswith('qcamera.m4a') and not os.path.exists(filepath):
            # Check disk cache first
            cache_path = get_cache_path(filepath)
            if os.path.exists(cache_path):
                self.serve_file_from_cache(cache_path, 'audio/mp4')
                return
                
            ts_path = filepath.rsplit('qcamera.m4a', 1)[0] + 'qcamera.ts'
            if os.path.exists(ts_path):
                data = self.get_cached_or_extract_audio(ts_path, filepath)
                if data:
                    self.serve_bytes(data, content_type='audio/mp4')
                    return
                else:
                    self.send_error(404, "Audio track not present or extraction failed")
                    return
        
        # Check if requested file is an .mp4 file that doesn't exist, but .hevc does
        if filepath.endswith('.mp4') and not os.path.exists(filepath):
            # Check disk cache first
            cache_path = get_cache_path(filepath)
            if os.path.exists(cache_path):
                self.serve_file_from_cache(cache_path, 'video/mp4')
                return
                
            hevc_path = filepath.rsplit('.mp4', 1)[0] + '.hevc'
            if os.path.exists(hevc_path):
                # Fetch from cache or transmux in-memory
                data = self.get_cached_or_transmux(hevc_path, filepath)
                if data:
                    self.serve_bytes(data)
                    return
                else:
                    self.send_error(500, "Transmux failed")
                    return

        # Fall back to standard static file serving
        super().do_GET()

    def get_cached_or_transmux(self, hevc_path, mp4_path):
        # Check cache first
        with cache_lock:
            if mp4_path in mp4_cache:
                print(f"[Memory Cache] Hit for: {mp4_path}")
                return mp4_cache[mp4_path]

        # Lock specific file to prevent duplicate concurrent runs
        lock = get_transmux_lock(mp4_path)
        with lock:
            # Double check cache inside lock
            with cache_lock:
                if mp4_path in mp4_cache:
                    return mp4_cache[mp4_path]

            print(f"[Memory Transmux] Transmuxing {hevc_path} directly to memory via pipe...")
            try:
                cmd = [
                    FFMPEG_PATH, "-y",
                    "-i", hevc_path,
                    "-c:v", "copy",
                    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                    "-f", "mp4",
                    "pipe:1"
                ]
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if res.returncode == 0:
                    data = res.stdout
                    print(f"[Memory Transmux] Completed (In-Memory Pipe): {hevc_path} ({len(data)} bytes)")
                    cache_mp4_data(mp4_path, data)
                    save_cache_to_disk(mp4_path, data)
                    return data
                else:
                    print(f"[Memory Transmux] Error: ffmpeg failed with code {res.returncode}")
                    print(f"ffmpeg stderr: {res.stderr.decode('utf-8', errors='ignore')}")
                    return None
            except Exception as e:
                print(f"[Memory Transmux] Exception: {e}")
                return None

    def get_cached_or_extract_audio(self, ts_path, m4a_path):
        # Check cache first
        with cache_lock:
            if m4a_path in mp4_cache:
                print(f"[Memory Cache] Audio Hit for: {m4a_path}")
                return mp4_cache[m4a_path]
                
        # Lock specific file to prevent duplicate concurrent runs
        lock = get_transmux_lock(m4a_path)
        with lock:
            # Double check cache inside lock
            with cache_lock:
                if m4a_path in mp4_cache:
                    return mp4_cache[m4a_path]
                    
            print(f"[Audio Extract] Extracting audio from {ts_path} to memory...")
            # Determine start PTS offset between video and audio
            delay_ms = 0
            try:
                # Get video first packet PTS
                cmd_v = [
                    FFPROBE_PATH, "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries", "packet=pts_time",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    "-read_intervals", "%+#1",
                    ts_path
                ]
                res_v = subprocess.run(cmd_v, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                v_pts = None
                if res_v.returncode == 0:
                    v_pts_str = res_v.stdout.decode('utf-8').strip()
                    if v_pts_str:
                        v_pts = float(v_pts_str)
                
                # Get audio first packet PTS
                cmd_a = [
                    FFPROBE_PATH, "-v", "error",
                    "-select_streams", "a:0",
                    "-show_entries", "packet=pts_time",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    "-read_intervals", "%+#1",
                    ts_path
                ]
                res_a = subprocess.run(cmd_a, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                a_pts = None
                if res_a.returncode == 0:
                    a_pts_str = res_a.stdout.decode('utf-8').strip()
                    if a_pts_str:
                        a_pts = float(a_pts_str)
                        
                if v_pts is not None and a_pts is not None:
                    diff = a_pts - v_pts
                    if diff > 0.05:
                        delay_ms = int(diff * 1000)
                        print(f"[Audio Extract] Delayed audio start detected (Video: {v_pts}s, Audio: {a_pts}s). Applying adelay={delay_ms}ms.")
            except Exception as e:
                print(f"[Audio Extract] Error calculating PTS delay: {e}")

            try:
                cmd = [
                    FFMPEG_PATH, "-y",
                    "-probesize", "10000000",
                    "-analyzeduration", "10000000",
                    "-i", ts_path,
                    "-vn"
                ]
                if delay_ms > 0:
                    # Delay L and R channels using compatible syntax that works on older ffmpeg versions
                    cmd.extend(["-af", f"adelay={delay_ms}|{delay_ms}"])
                cmd.extend([
                    "-c:a", "aac"
                ])
                cmd.extend([
                    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                    "-f", "mp4",
                    "pipe:1"
                ])
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if res.returncode == 0 and len(res.stdout) > 0:
                    data = res.stdout
                    print(f"[Audio Extract] Completed (In-Memory Pipe): {ts_path} ({len(data)} bytes)")
                    cache_mp4_data(m4a_path, data)
                    save_cache_to_disk(m4a_path, data)
                    return data
                else:
                    print(f"[Audio Extract] Error: ffmpeg failed with code {res.returncode}")
                    print(f"ffmpeg stderr: {res.stderr.decode('utf-8', errors='ignore')}")
                    return None
            except Exception as e:
                print(f"[Audio Extract] Exception: {e}")
                return None

    def serve_bytes(self, data, content_type='video/mp4'):
        status = 200
        start = 0
        end = len(data) - 1
        is_range_request = False
        
        range_header = self.headers.get('Range')
        if range_header and range_header.startswith('bytes='):
            try:
                range_str = range_header.split('bytes=')[1]
                parts = range_str.split('-')
                
                if parts[0]:
                    start = int(parts[0])
                if len(parts) > 1 and parts[1]:
                    end = int(parts[1])
                
                end = min(end, len(data) - 1)
                
                if start <= end:
                    status = 206
                    is_range_request = True
            except ValueError:
                pass
                
        try:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-cache')
            
            if is_range_request:
                content_length = end - start + 1
                self.send_header('Content-Length', str(content_length))
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
                self.end_headers()
                self.wfile.write(data[start:end+1])
            else:
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError) as e:
            # Silence expected client disconnection errors
            pass
        except Exception as e:
            print(f"[Server] Unexpected error sending response: {e}")

    def get_fallback_mtime(self, route_path):
        route_dir = os.path.join(WORKSPACE, route_path)
        for filename in ["qlog.zst", "ecamera.hevc", "ecamera.mp4"]:
            filepath = os.path.join(route_dir, filename)
            if os.path.exists(filepath):
                mtime = os.path.getmtime(filepath)
                return datetime.datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M:%S')
        return ""

    def get_accurate_segment_time(self, route_path):
        parent_dir, folder_name = os.path.split(route_path)
        if "--" in folder_name:
            parts = folder_name.split('--')
            if len(parts) >= 3:
                route_prefix = "--".join(parts[:-1])
                segment_index = int(parts[-1])
            else:
                route_prefix = folder_name
                segment_index = 0
        else:
            route_prefix = folder_name
            segment_index = 0

        # Find all sibling folders
        sibling_folders = []
        search_dir = os.path.join(WORKSPACE, parent_dir) if parent_dir else WORKSPACE
        if os.path.exists(search_dir):
            try:
                for item in os.listdir(search_dir):
                    if item.startswith(route_prefix + "--") and os.path.isdir(os.path.join(search_dir, item)):
                        sibling_folders.append(item)
            except Exception as e:
                print(f"[Dynamic Routes] Error listing siblings: {e}")

        # Sort siblings by segment index to find the highest index
        def get_seg_idx(name):
            try:
                return int(name.split('--')[-1])
            except Exception:
                return 0

        sibling_folders.sort(key=get_seg_idx)
        
        if sibling_folders:
            last_sibling = sibling_folders[-1]
            last_idx = get_seg_idx(last_sibling)
            
            last_sib_path = os.path.join(parent_dir, last_sibling)
            last_mtime = self.get_fallback_mtime(last_sib_path)
            
            if last_mtime:
                try:
                    dt_last = datetime.datetime.strptime(last_mtime, '%Y-%m-%d %H:%M:%S')
                    # Back-propagate start time to segment 0, and then offset to current segment_index
                    offset_sec = (segment_index - last_idx) * 60.0
                    seg_dt = dt_last + datetime.timedelta(seconds=offset_sec)
                    return seg_dt.strftime('%Y-%m-%d %H:%M:%S')
                except Exception as e:
                    print(f"[Dynamic Routes] Error parsing mtime: {e}")
                    
        return self.get_fallback_mtime(route_path)

    def send_routes_json(self):
        # Find all route subdirectories in WORKSPACE (and WORKSPACE/realdata if it exists)
        subdirs = []
        try:
            for item in os.listdir(WORKSPACE):
                if "car-fire" in item:
                    continue
                full_path = os.path.join(WORKSPACE, item)
                if os.path.isdir(full_path) and not item.startswith("."):
                    # Check if it contains videos directly
                    if any(f.endswith(".hevc") or f.endswith(".mp4") for f in os.listdir(full_path)):
                        subdirs.append(item)
                    # Also scan one level deeper (like realdata/segment)
                    else:
                        try:
                            for subitem in os.listdir(full_path):
                                if "car-fire" in subitem:
                                    continue
                                sub_full_path = os.path.join(full_path, subitem)
                                if os.path.isdir(sub_full_path) and not subitem.startswith("."):
                                    if any(f.endswith(".hevc") or f.endswith(".mp4") for f in os.listdir(sub_full_path)):
                                        subdirs.append(f"{item}/{subitem}")
                        except Exception:
                            pass
        except Exception as e:
            print(f"[Dynamic Routes] Error listing directory: {e}")
        
        # Sort subdirs alphabetically
        subdirs.sort()
            
        routes_data = []
        for s in subdirs:
            rtype = self.get_route_type(s)
            
            # Determine start time using the accurate segment time algorithm
            start_time = self.get_accurate_segment_time(s)
            route_dir = os.path.join(WORKSPACE, s)
            
            # Check which cameras exist in the route directory
            has_ecamera_hevc = os.path.exists(os.path.join(route_dir, "ecamera.hevc"))
            has_dcamera_hevc = os.path.exists(os.path.join(route_dir, "dcamera.hevc"))
            has_fcamera_hevc = os.path.exists(os.path.join(route_dir, "fcamera.hevc"))

            has_ecamera = has_ecamera_hevc or os.path.exists(os.path.join(route_dir, "ecamera.mp4"))
            has_dcamera = has_dcamera_hevc or os.path.exists(os.path.join(route_dir, "dcamera.mp4"))
            has_fcamera = has_fcamera_hevc or os.path.exists(os.path.join(route_dir, "fcamera.mp4"))
                    
            routes_data.append({
                "name": s,
                "type": rtype,
                "start_time": start_time,
                "has_ecamera": has_ecamera,
                "has_dcamera": has_dcamera,
                "has_fcamera": has_fcamera,
                "has_ecamera_hevc": has_ecamera_hevc,
                "has_dcamera_hevc": has_dcamera_hevc,
                "has_fcamera_hevc": has_fcamera_hevc
            })
            
        json_bytes = json.dumps(routes_data, indent=2).encode('utf-8')
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(json_bytes))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(json_bytes)

    def get_route_type(self, route_name):
        route_dir = os.path.join(WORKSPACE, route_name)
        if not os.path.isdir(route_dir):
            return "unknown"
            
        # Check if it's cached in memory
        mp4_path = os.path.join(route_dir, "ecamera.mp4")
        with cache_lock:
            if mp4_path in mp4_cache:
                return "hevc mp4"

        mp4_exists = os.path.exists(mp4_path)
        hevc_exists = os.path.exists(os.path.join(route_dir, "ecamera.hevc"))
        
        # If no mp4 exists but hevc does, it's a raw hevc stream
        if not mp4_exists and hevc_exists:
            return "raw hevc stream"
            
        if mp4_exists:
            # Check codec using ffprobe
            cmd = [
                FFPROBE_PATH, "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                mp4_path
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if res.returncode == 0:
                codec = res.stdout.decode('utf-8').strip()
                if codec == "h264":
                    return "h264 mp4"
                elif codec in ["hevc", "h265"]:
                    return "hevc mp4"
            return "h264 mp4" # default fallback
            
        return "unknown"

    def send_telemetry_json(self, route_name):
        # Prevent path traversal
        if ".." in route_name or route_name.startswith("/"):
            self.send_error(400, "Invalid route name")
            return
            
        route_dir = os.path.join(WORKSPACE, route_name)
        qlog_path = os.path.join(route_dir, "qlog.zst")
        telemetry_json_path = get_cache_path(os.path.join(route_dir, "telemetry.json"))
        
        # 1. Check in-memory cache
        with telemetry_lock:
            if route_name in telemetry_cache:
                self.serve_json(telemetry_cache[route_name])
                return
                
        # 2. Check disk cache
        if os.path.exists(telemetry_json_path):
            try:
                with open(telemetry_json_path, 'r', encoding='utf-8') as f:
                    telemetry = json.load(f)
                with telemetry_lock:
                    telemetry_cache[route_name] = telemetry
                print(f"[Telemetry] Loaded from disk cache: {telemetry_json_path}")
                self.serve_json(telemetry)
                return
            except Exception as e:
                print(f"[Telemetry] Error reading disk cache: {e}")
            
        if not os.path.exists(qlog_path):
            self.send_error(404, f"Telemetry log not found for route {route_name}")
            return
            
        print(f"[Telemetry] Extracting from {qlog_path}...")
        try:
            # Check if schemas are loaded
            global log_capnp
            if log_capnp is None:
                load_schemas()
                if log_capnp is None:
                    self.send_error(500, "Capnp schemas not loaded")
                    return
            
            dctx = zstandard.ZstdDecompressor()
            with open(qlog_path, 'rb') as f:
                compressed = f.read()
            with dctx.stream_reader(compressed) as reader:
                dat = reader.read()
                
            events = list(log_capnp.Event.read_multiple_bytes(dat))
            events.sort(key=lambda x: x.logMonoTime)
            
            road_frames = [e for e in events if e.which() == 'roadEncodeIdx']
            if road_frames:
                road_frames.sort(key=lambda x: x.roadEncodeIdx.frameId)
                start_time = road_frames[0].roadEncodeIdx.timestampSof
            else:
                start_time = events[0].logMonoTime
                
            sample_rate = 5 # 5Hz keeps payload small and UI update rate smooth
            interval = 1.0 / sample_rate
            num_samples = int(60.0 * sample_rate) + 1
            
            telemetry = []
            state = {
                "speed": 0.0,
                "steering_angle": 0.0,
                "gas": False,
                "brake": False,
                "left_blinker": False,
                "right_blinker": False,
                "gear": "unknown",
                "seatbelt_unlatched": False,
                "lat": None,
                "lng": None,
                "bearing": None,
                "gps_speed": None,
                "cpu_temp": 0.0,
                "alert_text1": "",
                "alert_text2": "",
                "alert_status": "normal",
                "alert_size": "none",
                "engaged": False
            }
            
            event_idx = 0
            num_events = len(events)
            
            for step in range(num_samples):
                t_target = step * interval
                t_target_ns = start_time + int(t_target * 1e9)
                
                while event_idx < num_events and events[event_idx].logMonoTime <= t_target_ns:
                    e = events[event_idx]
                    etype = e.which()
                    
                    if etype == 'carState':
                        cs = e.carState
                        state["speed"] = float(cs.vEgo)
                        state["steering_angle"] = float(cs.steeringAngleDeg)
                        state["gas"] = bool(cs.gasPressed)
                        state["brake"] = bool(cs.brakePressed)
                        state["left_blinker"] = bool(cs.leftBlinker)
                        state["right_blinker"] = bool(cs.rightBlinker)
                        state["gear"] = str(cs.gearShifter)
                        state["seatbelt_unlatched"] = bool(cs.seatbeltUnlatched)
                        
                    elif etype == 'gpsLocation':
                        gps = e.gpsLocation
                        if gps.hasFix:
                            state["lat"] = float(gps.latitude)
                            state["lng"] = float(gps.longitude)
                            state["bearing"] = float(gps.bearingDeg)
                            state["gps_speed"] = float(gps.speed)
                            
                    elif etype == 'deviceState':
                        ds = e.deviceState
                        if hasattr(ds, 'maxTempC') and ds.maxTempC > 0:
                            state["cpu_temp"] = float(ds.maxTempC)
                        elif hasattr(ds, 'cpuTempC') and len(ds.cpuTempC) > 0:
                            state["cpu_temp"] = float(sum(ds.cpuTempC) / len(ds.cpuTempC))
                            
                    elif etype == 'selfdriveState':
                        sds = e.selfdriveState
                        state["alert_text1"] = str(sds.alertText1)
                        state["alert_text2"] = str(sds.alertText2)
                        state["alert_status"] = str(sds.alertStatus)
                        state["alert_size"] = str(sds.alertSize)
                        state["engaged"] = bool(sds.enabled or sds.active)
                        
                    event_idx += 1
                    
                pt = state.copy()
                pt["time"] = round(t_target, 2)
                telemetry.append(pt)
                
            print(f"[Telemetry] Extracted {len(telemetry)} points for {route_name}")
            with telemetry_lock:
                telemetry_cache[route_name] = telemetry
                
            # Save telemetry to disk cache in background
            def save_telemetry():
                try:
                    dir_name = os.path.dirname(telemetry_json_path)
                    os.makedirs(dir_name, exist_ok=True)
                    temp_fd, temp_path = tempfile.mkstemp(dir=dir_name)
                    try:
                        with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
                            json.dump(telemetry, f, indent=2)
                        os.replace(temp_path, telemetry_json_path)
                        print(f"[Telemetry] Saved to disk cache: {telemetry_json_path}")
                    except Exception as e:
                        if os.path.exists(temp_path):
                            os.remove(temp_path)
                        print(f"[Telemetry] Error saving telemetry to disk: {e}")
                except Exception as e:
                    print(f"[Telemetry] Thread error: {e}")
            threading.Thread(target=save_telemetry, daemon=True).start()
            
            self.serve_json(telemetry)
            
        except Exception as e:
            print(f"[Telemetry] Error extracting telemetry: {e}")
            self.send_error(500, f"Error extracting telemetry: {e}")

    def serve_json(self, data):
        json_bytes = json.dumps(data).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(json_bytes))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(json_bytes)

def run():
    global PORT, WORKSPACE
    class SilentThreadingHTTPServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            # Silence BrokenPipeError and ConnectionResetError (expected client disconnections during media streaming)
            import sys
            exctype, value = sys.exc_info()[:2]
            if exctype in (BrokenPipeError, ConnectionResetError) or (value and 'Broken pipe' in str(value)):
                pass
            else:
                super().handle_error(request, client_address)

    default_ws = "/data/media/0/realdata/"
    if not os.path.exists(default_ws):
        default_ws = "."

    parser = argparse.ArgumentParser(
        description="Multi-threaded Comma.ai 360° Panorama Viewer Server. "
                    "Extracts audio tracks on-the-fly and transmuxes video segments in memory."
    )
    parser.add_argument(
        "workspace",
        nargs="?",
        default=default_ws,
        help=f"Path to the video route directory containing segment folders (default: {default_ws})."
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=8080,
        help="Port number to run the HTTP server on (default: 8080)."
    )
    args = parser.parse_args()
    
    PORT = args.port
    WORKSPACE = os.path.abspath(args.workspace)

    # Change working directory to WORKSPACE to ensure SimpleHTTPRequestHandler works correctly
    os.chdir(WORKSPACE)
    load_schemas()
    server_address = ('', PORT)
    # Use SilentThreadingHTTPServer to handle requests concurrently
    httpd = SilentThreadingHTTPServer(server_address, CommaVidRequestHandler)
    print(f"Starting custom multi-threaded comma-vid-viewer server on port {PORT}...")
    print(f"Serving workspace: {WORKSPACE}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()

if __name__ == '__main__':
    run()

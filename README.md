# Comma 360 Viewer

https://github.com/user-attachments/assets/3f6604db-b97d-48c8-963b-f5a5fcc28282



An interactive, browser-based WebGL panorama viewer designed to visualize Comma Three road cameras (`ecamera` and `fcamera`) and driver camera (`dcamera`) in a unified, synchronized space. The application dynamically dewarps the fisheye wide lens streams to reconstruct a complete 360-degree interactive panorama with real-time HUD and synchronized audio playback.

## Features
- **360-Degree WebGL Projections**: Dewarps and stitches wide-angle front, zoom-in, and driver cameras.
- **No export needed**: Raw streams are transmuxed on the fly and sent straight to your favorite browser. 
- **Dynamic Calibration Control**: Adjust focal lengths, max theta fields, and camera pan/rotations in real-time.
- **Synchronized Playback**: Syncs multiple video feeds (`ecamera`, `fcamera`, `dcamera`) and audio track (`qcamera.m4a`).
- **Telemetry HUD**: Interactive Leaflet maps tracking real-time GPS coordinates, speed, and drift synchronization lights.
- **Responsive Layout**: Designed for seamless desktop, tablet, and mobile viewing (including fullscreen mode). Perfect for reviewing footage in the field. 

---

## Deployment & Running on Comma Three

Since the Comma Three home directory is volatile and wiped on reboot, the application is persistently deployed to the `/data` partition (`/data/comma-360-viewer`). 

The installation script registers the viewer service as a managed process inside openpilot's process manager (`process_config.py`). Once registered:
- The viewer **auto-starts** in the background whenever the car is **offroad** (parked).
- The viewer **auto-stops** when the car is **onroad** (driving) to ensure zero overhead/interference with active driving safety systems.
- There is **no need to maintain an SSH connection** or manually run startup scripts.

> [!WARNING]
> The code survives minor openpilot updates, but the registration of getting it to auto-start does not. So you would need to rerun the following installation script after an update. 

### Installation / Updates
To install the viewer for the first time, or to pull the latest updates from GitHub and re-inject the configuration:
1. SSH into your Comma Three.
2. Run this single command:
   ```bash
   curl -sSL https://raw.githubusercontent.com/MingchenZhang/comma-360-viewer/main/deploy.sh | bash
   ```
3. Reboot the device or restart the openpilot manager for the changes to take effect.

---

## How to Access in the Field

Once installed and running via openpilot's process manager, the viewer is active whenever the car is parked. You can connect your phone, tablet, or laptop using one of these two methods:

### Method 1: Comma Three Wi-Fi Hotspot (Tethering)
1. On your Comma Three, enable the Wi-Fi Hotspot (Tethering) in **Network** -> **Advanced**.
2. Connect your device (phone, tablet, or laptop) to the Comma Three's Wi-Fi network.
3. Open your browser and navigate to:
   ```
   http://192.168.43.1:8082
   ```

### Method 2: Phone Hotspot Connection
1. Turn on the Personal Hotspot on your phone.
2. Connect your Comma Three to your phone's Wi-Fi hotspot.
3. Find the IP address of the Comma Three in **Settings** -> **Network** -> **Advanced**.
4. Open your browser on your phone and navigate to the Comma Three's IP address on port `8082`:
   ```
   http://<comma-ip-address>:8082
   ```

---

## Calibration

I have only used this on my comma 3X and I have set the default calibration to fit my footage perfectly. However, I have no idea how alignment differs across units of comma 3X. If you need to adjust your alignment:

You can use keyboard key D or double click the green online icon to activate the calibration menu to adjust alignment for your Comma. Alignment results are saved server-side in `calibration.json` (inside the installation directory), so your settings are preserved across different devices and browser sessions.

While in the calibration interface, holding Q enables blended view with footage overlapping, and holding W shows the driver camera with higher priority. Pressing A returns to the horizon, which I found useful initially to get the front fisheye pitch correct. 

---

## Disk Space & Cache Precautions

To support fast load times, the backend server automatically transmuxes HEVC streams into browser-playable MP4 containers and caches the results on disk under the `/data/comma-360-viewer/.cache/` directory.

> [!TIP]
> If you use **Firefox**, the transmuxing happens in the browser, so **no large video caching files are generated**. This web app tries to do that on Chrome, but it currently fails. See `muxing_guide.md` for explanation. 

### Automatic Cache Eviction
Since video cache files can be very large (up to ~75MB per segment per camera), the server includes a **diligent disk space protection cleaner** that runs in the background. Whenever a new cache file is written:
- It checks if the `.cache` directory size exceeds **2 GiB**.
- It checks if the remaining disk space on the partition drops below **5 GiB**.
- If either condition is met, the server automatically deletes the **oldest cached route segment** (using file modification times) in a loop until the system is within safe limits.

*No manual cache clearing is needed; the server will manage its own footprint dynamically. However, do be aware of these files when you have other files requiring disk space.*

---

## License & Credits

This project is licensed under the [MIT License](LICENSE).

### Third-Party Libraries
This application vendors and uses the following open-source libraries:
- **[Three.js](https://github.com/mrdoob/three.js)** (MIT License) - WebGL 3D/panoramic rendering
- **[JMuxer](https://github.com/samirkumardas/jmuxer)** (MIT License) - Browser-side raw H.264/H.265 media stream muxing
- **[Leaflet](https://github.com/Leaflet/Leaflet)** (BSD 2-Clause License) - Interactive map overlay
- **[Lucide Icons](https://github.com/lucide-icons/lucide)** (ISC License) - Modern UI icons

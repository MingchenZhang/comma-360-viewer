# Comma 360 Viewer

https://github.com/user-attachments/assets/3f6604db-b97d-48c8-963b-f5a5fcc28282



An interactive, browser-based WebGL panorama viewer designed to visualize Comma Three road cameras (`ecamera` and `fcamera`) and driver camera (`dcamera`) in a unified, synchronized space. The application dynamically dewarps the fisheye wide lens streams to reconstruct a complete 360-degree interactive panorama with real-time HUD and synchronized audio playback.

## Features
- **360-Degree WebGL Projections**: Dewarps and stitches wide-angle front, zoom-in, and driver cameras.
- **Dynamic Calibration Control**: Adjust focal lengths, max theta fields, and camera pan/rotations in real-time.
- **Synchronized Playback**: Syncs multiple video feeds (`ecamera`, `fcamera`, `dcamera`) and audio track (`qcamera.m4a`).
- **Telemetry HUD**: Interactive Leaflet maps tracking real-time GPS coordinates, speed, and drift synchronization lights.
- **Responsive Layout**: Designed for seamless desktop, tablet, and mobile viewing (including fullscreen mode).

---

## Deployment & Running on Comma Three

Since the Comma Three home directory is volatile and wiped on reboot, the application is persistently deployed to the `/data` partition (`/data/comma-360-viewer`).

### Option A: Running with Internet (First Time Install / Update)
To install the viewer for the first time, or to pull the latest updates from GitHub and restart the server, SSH into your Comma Three and run this single command:
```bash
curl -sSL https://raw.githubusercontent.com/MingchenZhang/comma-360-viewer/main/deploy.sh | bash
```

### Option B: Running without Internet (Offline Mode in the Field)
If you do not have internet, the remote GitHub server won't be reachable. You can run/restart the server offline using the locally cached copy of the deployment script:
```bash
/data/comma-360-viewer/deploy.sh
```
*Note: The script will automatically skip checking for updates on GitHub and launch using the local cached codebase.*

---

## How to Access in the Field

*You still need to ensure your phone have the ssh key to log into comma.*
When you are out in the field (e.g. in your car), you can connect your mobile device or laptop to the viewer using one of these two connection methods:

### Method 1: Comma Three Wi-Fi Hotspot (Tethering)
1. On your Comma Three, enable the Wi-Fi Hotspot (Tethering) in the Network -> Advanced.
2. Connect your phone, tablet, or laptop to the Comma Three's Wi-Fi network.
3. Use your favorite ssh terminal to connect to Comma and run the `deploy.sh`.
4. Open your browser and navigate to the address shown by the deployment script (usually `http://192.168.43.1:8082`).

### Method 2: Phone Hotspot Connection
1. Turn on the Personal Hotspot on your phone.
2. Connect your Comma Three to your phone's Wi-Fi hotspot.
3. Use your favorite ssh terminal to connect to Comma and run the `deploy.sh`.
4. Open your browser on your phone and navigate to the Comma Three's IP address on port `8082` (e.g., `http://<comma-ip-address>:8082`).

---

## Calibration

I have only used this on my comma 3X and I have no idea how alignment differ across units of comma 3X. You can use keyboard key D or double click the green online icon to activate the calibration menu to adjust alignment for your device. 
While in calibration interface, holding Q to enable blended view with footage overlapping, holding W to show driver camera with higher priority. Pressing A to return to horizon, which i found useful initally to get the front fisheye pitch correct. 

---

## Disk Space & Cache Precautions

To support fast load times, the backend server automatically transmuxes HEVC streams into browser-playable MP4 containers and caches the results on disk under the `.cache/` directory.

### Automatic Cache Eviction
Since video cache files can be very large (up to ~75MB per segment per camera), the server includes a **diligent disk space protection cleaner** that runs in the background. Whenever a new cache file is written:
- It checks if the `.cache` directory size exceeds **2 GiB**.
- It checks if the remaining disk space on the partition drops below **5 GiB**.
- If either condition is met, the server automatically deletes the **oldest cached route segment** (using file modification times) in a loop until the system is within safe limits.

*No manual cache clearing is needed; the server will manage its own footprint dynamically. However do be aware of these files when youhave other files requiring disk space.*

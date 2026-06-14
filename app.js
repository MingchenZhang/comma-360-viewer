import * as THREE from './js/three.module.js';
import { OrbitControls } from './js/OrbitControls.js';

// Application State
const state = {
    playback: {
        isPlaying: false,
        speed: 1.0,
        currentTime: 0,
        duration: 60.0, // Default to 60s, will update once videos load
        telemetry: null
    },
    calibration: {
        // Front Camera (ecamera) World Euler Angles
        frontYaw: 180,      // facing forward (-Z) by default
        frontPitch: 6.5,
        frontRoll: 0,
        frontFocal: 0.29,   // horizontal scale factor (zoomed out for crossover)
        frontMaxTheta: 86.0,
        frontMaxThetaBias: 6.0,
        frontPanX: -20.0,
        frontPanY: 0.0,
        frontPanZ: 0.0,
        
        // Driver Camera (dcamera) World Euler Angles
        driverYaw: 0,       // facing backward (+Z) by default
        driverPitch: 14.0,
        driverRoll: 0,
        driverFocal: 0.29,  // horizontal scale factor
        driverMaxTheta: 92.0,
        driverPanX: 0.0,
        driverPanY: -43.5,
        driverPanZ: 3.0,

        // Zoomed-in Camera (fcamera) World Euler Angles
        narrowYaw: 180,
        narrowPitch: 4.5,
        narrowRoll: 0,
        narrowFocal: 1.22,
        narrowMaxTheta: 40.0,
        narrowPanX: 1.5,
        narrowPanY: 0.0,
        narrowPanZ: 0.0,
        
        radius: 10.0,
        
        // Texture coordinate flips (to correct lens mirrors in WebGL)
        frontFlipX: -1.0,   
        driverFlipX: -1.0,
        narrowFlipX: -1.0,

        // Developer Mode flag
        devMode: false
    },
    cameras: {
        ecamera: { el: null, texture: null, loaded: false },
        dcamera: { el: null, texture: null, loaded: false },
        fcamera: { el: null, texture: null, loaded: false }
    },
    routesList: []
};

// Three.js Globals
let scene, camera, renderer, controls;
let projectionMesh; // Single combined sphere mesh
let combinedMaterial; // Single shader material with multi-texture mapping
let carCabinMesh; // Wireframe cabin overlay
let horizonLine, verticalLine; // Dev guide lines

// Telemetry Globals
let telMap = null;
let telMarker = null;
let telPolyline = null;
let isTelemetryVisible = false;

// Initialize App
async function initApp() {
    // Load persisted calibration parameters
    loadCalibrationFromStorage();

    // 1. Initialize Lucide Icons
    if (window.lucide) {
        window.lucide.createIcons();
    }

    // 1.5. Initialize Route Selector
    await initRouteSelector();

    // 2. Setup Video Elements
    setupVideos();

    // 3. Setup ThreeJS Scene
    initThree();

    // 4. Setup UI Event Listeners
    setupUIListeners();

    // 5. Start Loop
    animate();
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Setup Video Elements (ecamera and dcamera only)
function setupVideos() {
    const ids = ['video-ecamera', 'video-dcamera', 'video-fcamera'];
    
    ids.forEach(id => {
        const key = id.replace('video-', '');
        const video = document.getElementById(id);
        
        state.cameras[key].el = video;
        
        // Setup video attributes
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        
        // Track load status
        video.addEventListener('loadedmetadata', () => {
            state.cameras[key].loaded = true;
            
            // Set track duration based on front camera
            if (key === 'ecamera') {
                let duration = video.duration;
                if (isNaN(duration) || duration === Infinity || duration <= 5.0) {
                    duration = 60.0;
                }
                state.playback.duration = duration;
                document.getElementById('timeline-slider').max = state.playback.duration;
                document.getElementById('time-duration').textContent = formatTime(state.playback.duration);
            }
            checkAllLoaded();
        });

        // Error handling
        video.addEventListener('error', (e) => {
            console.error(`Error loading video ${key}:`, e);
            const overlay = document.getElementById('loading-overlay');
            if (overlay) {
                // Ensure overlay is shown
                overlay.style.display = 'flex';
                overlay.style.opacity = '1';
                
                // Hide spinner
                const spinner = overlay.querySelector('.loader-spinner');
                if (spinner) spinner.style.display = 'none';
                
                // Show descriptive error message
                const textEl = overlay.querySelector('.loader-text');
                if (textEl) {
                    textEl.innerHTML = `<span style="color: #ff3b30; font-weight: bold; font-family: var(--font-heading);">LOAD ERROR</span><br>` +
                                      `<span style="font-size: 0.85rem; color: var(--text-secondary);">` +
                                      `Failed to load <b>${key}</b> (${video.src.split('/').pop()}).<br>` +
                                      `This browser/OS configuration may lack hardware-accelerated H.265 (HEVC) decode support.</span>`;
                }
            }
        });

        // Trigger load
        video.load();
    });

    // Setup Audio Track Element
    const audio = document.getElementById('audio-track');
    if (audio) {
        audio.muted = true;
        audio.loop = true;
        
        audio.addEventListener('loadedmetadata', () => {
            console.log("[Audio] Track metadata loaded successfully. Showing mute button.");
            const btnMute = document.getElementById('btn-mute');
            if (btnMute) {
                btnMute.style.display = 'flex';
            }
            
            // Sync button UI to current muted state
            const muteIcon = document.getElementById('mute-icon');
            if (btnMute && muteIcon) {
                if (audio.muted) {
                    btnMute.classList.remove('active');
                    btnMute.style.borderColor = '';
                    btnMute.style.color = '';
                    muteIcon.setAttribute('data-lucide', 'volume-x');
                } else {
                    btnMute.classList.add('active');
                    btnMute.style.borderColor = 'var(--color-primary)';
                    btnMute.style.color = 'var(--color-primary)';
                    muteIcon.setAttribute('data-lucide', 'volume-2');
                }
                if (window.lucide) {
                    window.lucide.createIcons();
                }
            }
        });
        
        audio.addEventListener('error', () => {
            console.log("[Audio] Track load failed or not present. Hiding mute button.");
            const btnMute = document.getElementById('btn-mute');
            if (btnMute) {
                btnMute.style.display = 'none';
            }
        });
        
        audio.load();
    }
}

function checkAllLoaded() {
    const allLoaded = Object.keys(state.cameras).every(k => state.cameras[k].loaded);
    if (allLoaded) {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => overlay.style.display = 'none', 500);
        }
        
        // Seek to the selected playback time once loaded
        if (state.playback.currentTime > 0) {
            console.log(`[Playback] All feeds loaded. Restoring time to: ${state.playback.currentTime}s`);
            syncTimeTo(state.playback.currentTime);
        }
    }
}

// Format seconds to MM:SS
function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Custom Fisheye Dewarping Shader (Combined Front & Rear into 1 pass)
const CombinedFisheyeShader = {
    vertexShader: `
        varying vec3 v_local_pos;
        void main() {
            // Send normalized local vertex coordinates (unit vector pointing from center)
            v_local_pos = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D u_texture_front;
        uniform sampler2D u_texture_driver;
        uniform sampler2D u_texture_narrow;
        
        uniform mat3 u_rotation_matrix_front;
        uniform mat3 u_rotation_matrix_driver;
        uniform mat3 u_rotation_matrix_narrow;
        
        uniform vec2 u_fov_scale_front;
        uniform vec2 u_fov_scale_driver;
        uniform vec2 u_fov_scale_narrow;
        
        uniform float u_max_theta_front;
        uniform float u_max_theta_front_bias;
        uniform float u_max_theta_driver;
        uniform float u_max_theta_narrow;
        uniform float u_flip_x_front;
        uniform float u_flip_x_driver;
        uniform float u_flip_x_narrow;
        
        uniform float u_sphere_radius;
        uniform vec3 u_pan_front;
        uniform vec3 u_pan_driver;
        uniform vec3 u_pan_narrow;
        
        uniform float u_overlap_mode;    // 0.0 = Front camera priority, 1.0 = 50/50 mix, 2.0 = Driver camera priority
        uniform float u_driver_enabled;   // 0.0 = Driver camera off, 1.0 = Driver camera on
        uniform float u_narrow_enabled;   // 0.0 = Narrow camera off, 1.0 = Narrow camera on
        
        varying vec3 v_local_pos;
        
        void main() {
            bool has_front = false;
            bool has_driver = false;
            bool has_narrow = false;
            vec4 color_front = vec4(0.0);
            vec4 color_driver = vec4(0.0);
            vec4 color_narrow = vec4(0.0);
            
            // 1. FRONT CAMERA (ecamera) LENS DEWARPING
            vec3 world_pos_front = v_local_pos * u_sphere_radius - u_pan_front;
            vec3 cam_pos_front = u_rotation_matrix_front * world_pos_front;
            float r_xy_front = length(cam_pos_front.xy);
            float theta_front = atan(r_xy_front, cam_pos_front.z);
            
            float limit_front = u_max_theta_front;
            if (r_xy_front > 0.0001) {
                limit_front += u_max_theta_front_bias * (cam_pos_front.x / r_xy_front);
            }
            
            if (theta_front <= limit_front) {
                vec2 dir_front = vec2(0.0);
                if (r_xy_front > 0.0001) {
                    dir_front = cam_pos_front.xy / r_xy_front;
                }
                vec2 uv_img_front = dir_front * theta_front;
                float u_f = 0.5 + u_flip_x_front * uv_img_front.x * u_fov_scale_front.x;
                float v_f = 0.5 + uv_img_front.y * u_fov_scale_front.y;
                
                if (u_f >= 0.0 && u_f <= 1.0 && v_f >= 0.0 && v_f <= 1.0) {
                    color_front = texture2D(u_texture_front, vec2(u_f, v_f));
                    has_front = true;
                }
            }
            
            // 2. DRIVER CAMERA (dcamera) LENS DEWARPING
            if (u_driver_enabled > 0.5) {
                vec3 world_pos_driver = v_local_pos * u_sphere_radius - u_pan_driver;
                vec3 cam_pos_driver = u_rotation_matrix_driver * world_pos_driver;
                float r_xy_driver = length(cam_pos_driver.xy);
                float theta_driver = atan(r_xy_driver, cam_pos_driver.z);
                
                if (theta_driver <= u_max_theta_driver) {
                    vec2 dir_driver = vec2(0.0);
                    if (r_xy_driver > 0.0001) {
                        dir_driver = cam_pos_driver.xy / r_xy_driver;
                    }
                    vec2 uv_img_driver = dir_driver * theta_driver;
                    float u_d = 0.5 + u_flip_x_driver * uv_img_driver.x * u_fov_scale_driver.x;
                    float v_d = 0.5 + uv_img_driver.y * u_fov_scale_driver.y;
                    
                    if (u_d >= 0.0 && u_d <= 1.0 && v_d >= 0.0 && v_d <= 1.0) {
                        color_driver = texture2D(u_texture_driver, vec2(u_d, v_d));
                        has_driver = true;
                    }
                }
            }
            
            // 3. ZOOMED-IN CAMERA (fcamera) LENS DEWARPING
            if (u_narrow_enabled > 0.5) {
                vec3 world_pos_narrow = v_local_pos * u_sphere_radius - u_pan_narrow;
                vec3 cam_pos_narrow = u_rotation_matrix_narrow * world_pos_narrow;
                float r_xy_narrow = length(cam_pos_narrow.xy);
                float theta_narrow = atan(r_xy_narrow, cam_pos_narrow.z);
                
                if (theta_narrow <= u_max_theta_narrow) {
                    vec2 dir_narrow = vec2(0.0);
                    if (r_xy_narrow > 0.0001) {
                        dir_narrow = cam_pos_narrow.xy / r_xy_narrow;
                    }
                    vec2 uv_img_narrow = dir_narrow * theta_narrow;
                    float u_n = 0.5 + u_flip_x_narrow * uv_img_narrow.x * u_fov_scale_narrow.x;
                    float v_n = 0.5 + uv_img_narrow.y * u_fov_scale_narrow.y;
                    
                    if (u_n >= 0.0 && u_n <= 1.0 && v_n >= 0.0 && v_n <= 1.0) {
                        color_narrow = texture2D(u_texture_narrow, vec2(u_n, v_n));
                        has_narrow = true;
                    }
                }
            }
            
            // 4. OVERLAP BLENDING & PRECEDENCE LOGIC
            if (u_overlap_mode > 0.5 && u_overlap_mode < 1.5) {
                // Mix mode (holding Q in Dev mode): continuous 50% opacity mapping for all cameras
                int num_present = 0;
                vec3 mix_color = vec3(0.0);
                if (has_front) { num_present += 1; mix_color += color_front.rgb * 0.5; }
                if (has_driver) { num_present += 1; mix_color += color_driver.rgb * 0.5; }
                if (has_narrow) { num_present += 1; mix_color += color_narrow.rgb * 0.5; }
                
                if (num_present == 0) {
                    discard;
                } else if (num_present == 1) {
                    gl_FragColor = vec4(mix_color * 2.0, 0.5);
                } else {
                    gl_FragColor = vec4(mix_color, 1.0);
                }
            } else {
                // Normal Mode or W Mode
                if (u_overlap_mode > 1.5) {
                    // W Mode (holding W in Dev mode): Driver camera has top priority
                    if (has_driver) {
                        gl_FragColor = color_driver;
                    } else if (has_narrow) {
                        gl_FragColor = color_narrow;
                    } else if (has_front) {
                        gl_FragColor = color_front;
                    } else {
                        discard;
                    }
                } else {
                    // Normal Mode: Zoomed-in camera has priority over front camera, front over driver
                    if (has_narrow) {
                        gl_FragColor = color_narrow;
                    } else if (has_front) {
                        gl_FragColor = color_front;
                    } else if (has_driver) {
                        gl_FragColor = color_driver;
                    } else {
                        discard;
                    }
                }
            }
        }
    `
};

// Initialize Three.js Viewport
function initThree() {
    const container = document.getElementById('three-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Create Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050608);
    scene.fog = new THREE.FogExp2(0x050608, 0.012);

    // Create Camera (Wide Starting FOV)
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 0, 0.01); // Positioned inside the spheres at the center

    // Create Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Set up OrbitControls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = false; // We handle zoom manually using camera FOV
    controls.enablePan = false;  // Lock camera to center
    controls.rotateSpeed = -1.0; // Invert rotate speed so dragging "pulls" the scene
    controls.target.set(0, 0, 0);

    // Zooming via FOV on scroll wheel
    renderer.domElement.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomSpeed = 0.05;
        let fov = camera.fov + e.deltaY * zoomSpeed;
        camera.fov = Math.max(30, Math.min(getMaxFov(), fov)); // constraint FOV
        camera.updateProjectionMatrix();
    });

    // Add lights (to light up cabin wireframe)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
    dirLight.position.set(0, 10, 0);
    scene.add(dirLight);

    // Setup Video Textures
    Object.keys(state.cameras).forEach(key => {
        const video = state.cameras[key].el;
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        state.cameras[key].texture = texture;
    });

    // Create Combined Fisheye Shader Material
    combinedMaterial = new THREE.ShaderMaterial({
        uniforms: {
            u_texture_front: { value: state.cameras.ecamera.texture },
            u_texture_driver: { value: state.cameras.dcamera.texture },
            u_texture_narrow: { value: state.cameras.fcamera.texture },
            u_rotation_matrix_front: { value: new THREE.Matrix3() },
            u_rotation_matrix_driver: { value: new THREE.Matrix3() },
            u_rotation_matrix_narrow: { value: new THREE.Matrix3() },
            u_fov_scale_front: { value: new THREE.Vector2(state.calibration.frontFocal, state.calibration.frontFocal * 1.596) },
            u_fov_scale_driver: { value: new THREE.Vector2(state.calibration.driverFocal, state.calibration.driverFocal * 1.596) },
            u_fov_scale_narrow: { value: new THREE.Vector2(state.calibration.narrowFocal, state.calibration.narrowFocal * 1.596) },
            u_max_theta_front: { value: THREE.MathUtils.degToRad(state.calibration.frontMaxTheta) },
            u_max_theta_front_bias: { value: THREE.MathUtils.degToRad(state.calibration.frontMaxThetaBias) },
            u_max_theta_driver: { value: THREE.MathUtils.degToRad(state.calibration.driverMaxTheta) },
            u_max_theta_narrow: { value: THREE.MathUtils.degToRad(state.calibration.narrowMaxTheta) },
            u_flip_x_front: { value: state.calibration.frontFlipX },
            u_flip_x_driver: { value: state.calibration.driverFlipX },
            u_flip_x_narrow: { value: state.calibration.narrowFlipX },
            u_sphere_radius: { value: state.calibration.radius },
            u_pan_front: { value: new THREE.Vector3() },
            u_pan_driver: { value: new THREE.Vector3() },
            u_pan_narrow: { value: new THREE.Vector3() },
            u_overlap_mode: { value: 0.0 },
            u_driver_enabled: { value: 1.0 },
            u_narrow_enabled: { value: 1.0 }
        },
        vertexShader: CombinedFisheyeShader.vertexShader,
        fragmentShader: CombinedFisheyeShader.fragmentShader,
        side: THREE.DoubleSide,
        transparent: true
    });

    // Create Single Sphere Geometry (128x128 segments for smooth pixel interpolation)
    const sphereGeo = new THREE.SphereGeometry(1, 128, 128);
    projectionMesh = new THREE.Mesh(sphereGeo, combinedMaterial);
    scene.add(projectionMesh);

    // Apply initial scale & rotations
    updateFisheyeProjections();

    // Create semi-transparent horizon line
    createHorizonLine();

    // Create semi-transparent vertical left-right line
    createVerticalLeftRightLine();

    // Disable OrbitControls touch handling to use our custom, unified touch handler
    controls.touches.ONE = null;
    controls.touches.TWO = null;

    let lastTouchX = 0;
    let lastTouchY = 0;
    let lastTouchDist = 0;
    let lastTouchMidX = 0;
    let lastTouchMidY = 0;

    function getTouchDistAndMid(e) {
        const x1 = e.touches[0].pageX;
        const y1 = e.touches[0].pageY;
        const x2 = e.touches[1].pageX;
        const y2 = e.touches[1].pageY;
        return {
            dist: Math.hypot(x1 - x2, y1 - y2),
            midX: (x1 + x2) / 2,
            midY: (y1 + y2) / 2
        };
    }

    function resetTouchBaseline(e) {
        if (e.touches.length === 1) {
            lastTouchX = e.touches[0].pageX;
            lastTouchY = e.touches[0].pageY;
            lastTouchDist = 0;
        } else if (e.touches.length === 2) {
            const data = getTouchDistAndMid(e);
            lastTouchDist = data.dist;
            lastTouchMidX = data.midX;
            lastTouchMidY = data.midY;
        }
    }

    renderer.domElement.addEventListener('touchstart', (e) => {
        // Prevent default browser behaviors (zoom, scroll)
        e.preventDefault();
        resetTouchBaseline(e);
    }, { passive: false });

    renderer.domElement.addEventListener('touchmove', (e) => {
        e.preventDefault();

        if (e.touches.length === 1) {
            const factor = (camera.fov * Math.PI / 180) / renderer.domElement.clientHeight;
            const x = e.touches[0].pageX;
            const y = e.touches[0].pageY;
            const dx = x - lastTouchX;
            const dy = y - lastTouchY;
            
            controls.rotateLeft( dx * factor * controls.rotateSpeed );
            controls.rotateUp( dy * factor * controls.rotateSpeed );
            controls.update();

            lastTouchX = x;
            lastTouchY = y;
        } else if (e.touches.length === 2) {
            const data = getTouchDistAndMid(e);
            
            // 1. Zoom (FOV)
            if (data.dist > 0 && lastTouchDist > 0) {
                const zoomFactor = lastTouchDist / data.dist;
                camera.fov = Math.max(30, Math.min(getMaxFov(), camera.fov * zoomFactor));
                camera.updateProjectionMatrix();
            }

            // 2. Rotate (Midpoint)
            const factor = (camera.fov * Math.PI / 180) / renderer.domElement.clientHeight;
            const dx = data.midX - lastTouchMidX;
            const dy = data.midY - lastTouchMidY;

            controls.rotateLeft( dx * factor * controls.rotateSpeed );
            controls.rotateUp( dy * factor * controls.rotateSpeed );
            controls.update();

            lastTouchDist = data.dist;
            lastTouchMidX = data.midX;
            lastTouchMidY = data.midY;
        }
    }, { passive: false });

    const handleTouchEnd = (e) => {
        e.preventDefault();
        resetTouchBaseline(e);
    };

    renderer.domElement.addEventListener('touchend', handleTouchEnd, { passive: false });
    renderer.domElement.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    // Resize Handler using ResizeObserver for smooth CSS transitions
    const resizeObserver = new ResizeObserver(() => {
        onWindowResize();
    });
    if (container) {
        resizeObserver.observe(container);
    }
}

// Update rotation matrices and uniforms for the fisheye shader
function updateFisheyeProjections() {
    if (!projectionMesh || !combinedMaterial) return;

    // 1. Scale mesh based on radius
    const r = state.calibration.radius;
    projectionMesh.scale.set(r, r, r);

    // 2. FRONT CAMERA (ecamera) ROTATION MATRIX
    updateRotationUniform(
        state.calibration.frontYaw,
        state.calibration.frontPitch,
        state.calibration.frontRoll,
        combinedMaterial.uniforms.u_rotation_matrix_front.value
    );
    
    // Front Uniforms
    combinedMaterial.uniforms.u_fov_scale_front.value.set(
        state.calibration.frontFocal,
        state.calibration.frontFocal * 1.596
    );

    // 3. DRIVER CAMERA (dcamera) ROTATION MATRIX
    updateRotationUniform(
        state.calibration.driverYaw,
        state.calibration.driverPitch,
        state.calibration.driverRoll,
        combinedMaterial.uniforms.u_rotation_matrix_driver.value
    );

    // Driver Uniforms
    combinedMaterial.uniforms.u_fov_scale_driver.value.set(
        state.calibration.driverFocal,
        state.calibration.driverFocal * 1.596
    );
    
    // 4. NARROW CAMERA (fcamera) ROTATION MATRIX
    updateRotationUniform(
        state.calibration.narrowYaw,
        state.calibration.narrowPitch,
        state.calibration.narrowRoll,
        combinedMaterial.uniforms.u_rotation_matrix_narrow.value
    );

    // Narrow Uniforms
    combinedMaterial.uniforms.u_fov_scale_narrow.value.set(
        state.calibration.narrowFocal,
        state.calibration.narrowFocal * 1.596
    );

    combinedMaterial.uniforms.u_max_theta_front.value = THREE.MathUtils.degToRad(state.calibration.frontMaxTheta);
    combinedMaterial.uniforms.u_max_theta_front_bias.value = THREE.MathUtils.degToRad(state.calibration.frontMaxThetaBias);
    combinedMaterial.uniforms.u_max_theta_driver.value = THREE.MathUtils.degToRad(state.calibration.driverMaxTheta);
    combinedMaterial.uniforms.u_max_theta_narrow.value = THREE.MathUtils.degToRad(state.calibration.narrowMaxTheta);

    combinedMaterial.uniforms.u_sphere_radius.value = state.calibration.radius;
    combinedMaterial.uniforms.u_pan_front.value.set(
        state.calibration.frontPanX / 100,
        state.calibration.frontPanY / 100,
        state.calibration.frontPanZ / 100
    );
    combinedMaterial.uniforms.u_pan_driver.value.set(
        state.calibration.driverPanX / 100,
        state.calibration.driverPanY / 100,
        state.calibration.driverPanZ / 100
    );
    combinedMaterial.uniforms.u_pan_narrow.value.set(
        state.calibration.narrowPanX / 100,
        state.calibration.narrowPanY / 100,
        state.calibration.narrowPanZ / 100
    );

    // Toggle driver visibility
    const driverEnabled = document.getElementById('driver-cam-toggle').checked;
    combinedMaterial.uniforms.u_driver_enabled.value = driverEnabled ? 1.0 : 0.0;

    // Toggle narrow visibility
    const narrowEnabled = document.getElementById('narrow-cam-toggle').checked;
    combinedMaterial.uniforms.u_narrow_enabled.value = narrowEnabled ? 1.0 : 0.0;

    // Persist new parameters to localStorage
    saveCalibrationToStorage();
}

// Compute inverse rotation matrix from Euler angles to map world -> camera space
function updateRotationUniform(yawDeg, pitchDeg, rollDeg, mat3Target) {
    const yawRad = THREE.MathUtils.degToRad(yawDeg);
    const pitchRad = THREE.MathUtils.degToRad(pitchDeg);
    const rollRad = THREE.MathUtils.degToRad(rollDeg);

    // Standard aircraft rotation order (Yaw, Pitch, Roll)
    const euler = new THREE.Euler(pitchRad, yawRad, rollRad, 'YXZ');
    
    const mat4 = new THREE.Matrix4().makeRotationFromEuler(euler);
    const mat3 = new THREE.Matrix3().setFromMatrix4(mat4);
    
    // Inverse matrix maps world coordinate direction to camera local coordinates
    const invMat3 = mat3.invert();
    mat3Target.copy(invMat3);
}



// Media Playback Sync Controls
function setPlaying(play) {
    state.playback.isPlaying = play;
    const playIcon = document.getElementById('play-icon');
    const playBtn = document.getElementById('btn-play-pause');
    const audio = document.getElementById('audio-track');
    
    if (play) {
        // Play front (ecamera)
        state.cameras.ecamera.el.play().catch(err => {
            console.warn("Autoplay blocked/failed for ecamera:", err);
        });
        
        // Play driver (dcamera) if enabled
        if (document.getElementById('driver-cam-toggle').checked) {
            state.cameras.dcamera.el.play().catch(() => {});
        }

        // Play narrow (fcamera) if enabled
        if (document.getElementById('narrow-cam-toggle').checked) {
            state.cameras.fcamera.el.play().catch(() => {});
        }
        
        // Play audio track
        if (audio && !isNaN(audio.duration)) {
            audio.play().catch(err => {
                console.warn("[Audio] Playback blocked:", err);
            });
        }
        
        playIcon.setAttribute('data-lucide', 'pause');
        playBtn.classList.add('active');
        playBtn.style.boxShadow = '0 0 15px var(--color-primary-glow)';
    } else {
        // Pause all
        state.cameras.ecamera.el.pause();
        state.cameras.dcamera.el.pause();
        state.cameras.fcamera.el.pause();
        
        // Pause audio track
        if (audio) {
            audio.pause();
        }
        
        playIcon.setAttribute('data-lucide', 'play');
        playBtn.classList.remove('active');
        playBtn.style.boxShadow = '0 4px 10px var(--color-primary-glow)';
    }
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

function updatePlaybackSpeed(speed) {
    state.playback.speed = speed;
    state.cameras.ecamera.el.playbackRate = speed;
    state.cameras.dcamera.el.playbackRate = speed;
    state.cameras.fcamera.el.playbackRate = speed;
    
    // Sync audio playback rate
    const audio = document.getElementById('audio-track');
    if (audio) {
        audio.playbackRate = speed;
    }
    
    // Update active button state
    document.querySelectorAll('.btn-group button').forEach(btn => {
        if (parseFloat(btn.dataset.speed) === speed) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// Toggle mute state and sync UI
function toggleMute() {
    const audio = document.getElementById('audio-track');
    const btnMute = document.getElementById('btn-mute');
    const muteIcon = document.getElementById('mute-icon');
    if (!audio || !btnMute || !muteIcon) return;

    audio.muted = !audio.muted;
    
    if (audio.muted) {
        btnMute.classList.remove('active');
        btnMute.style.borderColor = '';
        btnMute.style.color = '';
        muteIcon.setAttribute('data-lucide', 'volume-x');
    } else {
        btnMute.classList.add('active');
        btnMute.style.borderColor = 'var(--color-primary)';
        btnMute.style.color = 'var(--color-primary)';
        muteIcon.setAttribute('data-lucide', 'volume-2');
    }
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Toggle left sidebar fold state
function toggleSidebar() {
    const layout = document.querySelector('.app-layout');
    const toggleIcon = document.getElementById('sidebar-toggle-icon');
    if (!layout) return;

    const isCollapsed = layout.classList.toggle('sidebar-collapsed');
    
    // Update Lucide icon
    if (toggleIcon) {
        toggleIcon.setAttribute('data-lucide', isCollapsed ? 'menu' : 'arrow-left');
    }
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Timeline seeking
function syncTimeTo(seconds) {
    state.playback.currentTime = seconds;
    
    document.getElementById('timeline-slider').value = seconds;
    const progressPercent = (seconds / state.playback.duration) * 100;
    document.getElementById('timeline-progress').style.width = `${progressPercent}%`;
    document.getElementById('time-current').textContent = formatTime(seconds);
    
    // Force seek on active video elements only if they have metadata loaded
    const ecamera = state.cameras.ecamera.el;
    if (ecamera && ecamera.readyState >= 1) {
        try { ecamera.currentTime = seconds; } catch (e) { console.warn("Failed to seek ecamera:", e); }
    }
    
    if (document.getElementById('driver-cam-toggle').checked) {
        const dcamera = state.cameras.dcamera.el;
        if (dcamera && dcamera.readyState >= 1) {
            try { dcamera.currentTime = seconds; } catch (e) { console.warn("Failed to seek dcamera:", e); }
        }
    }
    if (document.getElementById('narrow-cam-toggle').checked) {
        const fcamera = state.cameras.fcamera.el;
        if (fcamera && fcamera.readyState >= 1) {
            try { fcamera.currentTime = seconds; } catch (e) { console.warn("Failed to seek fcamera:", e); }
        }
    }

    // Force seek on audio if present and ready
    const audio = document.getElementById('audio-track');
    const btnMute = document.getElementById('btn-mute');
    const hasAudio = btnMute && btnMute.style.display !== 'none';
    if (hasAudio && audio && audio.readyState >= 1 && !isNaN(audio.duration)) {
        try { audio.currentTime = seconds; } catch (e) { console.warn("Failed to seek audio:", e); }
    }
}

// Periodically checks that videos are in sync and updates timeline UI
function runSyncDiagnostics() {
    const primaryVid = state.cameras.ecamera.el;
    const driverVid = state.cameras.dcamera.el;
    const narrowVid = state.cameras.fcamera.el;
    const driverEnabled = document.getElementById('driver-cam-toggle').checked;
    const narrowEnabled = document.getElementById('narrow-cam-toggle').checked;
    
    if (!state.cameras.ecamera.loaded || !primaryVid) return;
    
    const masterTime = primaryVid.currentTime;
    state.playback.currentTime = masterTime;

    // Update slider UI (if user isn't scrubbing)
    if (!isUserSeeking) {
        document.getElementById('timeline-slider').value = masterTime;
        const progressPercent = (masterTime / state.playback.duration) * 100;
        document.getElementById('timeline-progress').style.width = `${progressPercent}%`;
        document.getElementById('time-current').textContent = formatTime(masterTime);
    }

    // Sync narrow camera to master time
    if (narrowEnabled && narrowVid && state.cameras.fcamera.loaded) {
        const drift = narrowVid.currentTime - masterTime;
        if (Math.abs(drift) > 0.15) {
            narrowVid.currentTime = masterTime;
            if (state.playback.isPlaying && narrowVid.paused) {
                narrowVid.play().catch(() => {});
            }
        }
    }

    // Sync audio to master time
    const audio = document.getElementById('audio-track');
    const btnMute = document.getElementById('btn-mute');
    const hasAudio = btnMute && btnMute.style.display !== 'none';
    if (hasAudio && audio && !isNaN(audio.duration)) {
        const drift = audio.currentTime - masterTime;
        if (Math.abs(drift) > 0.15) {
            audio.currentTime = masterTime;
            if (state.playback.isPlaying && audio.paused) {
                audio.play().catch(() => {});
            }
        }
    }

    // Sync driver camera to front camera timeline
    const syncHud = document.getElementById('sync-hud');
    const syncText = document.getElementById('sync-text');
    const syncDriftVal = document.getElementById('sync-drift');
    const syncLight = syncHud.querySelector('.sync-light');

    if (driverEnabled && driverVid && state.cameras.dcamera.loaded) {
        const drift = driverVid.currentTime - masterTime;
        const absDrift = Math.abs(drift);
        
        syncDriftVal.textContent = `Drift: ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s`;
        
        if (absDrift > 0.15) {
            driverVid.currentTime = masterTime;
            if (state.playback.isPlaying && driverVid.paused) {
                driverVid.play().catch(() => {});
            }
            syncText.textContent = "SYNCHRONIZING";
            syncLight.className = "sync-light yellow";
            syncLight.style.backgroundColor = "var(--color-yellow)";
            syncLight.style.boxShadow = "0 0 8px var(--color-yellow)";
        } else {
            syncText.textContent = "SYNCHRONIZED";
            syncLight.className = "sync-light green";
            syncLight.style.backgroundColor = "var(--color-green)";
            syncLight.style.boxShadow = "0 0 8px var(--color-green)";
        }
    } else {
        syncText.textContent = "FRONT ONLY";
        syncLight.className = "sync-light green";
        syncDriftVal.textContent = "Driver camera disabled";
    }
}

// Seeker state flag
let isUserSeeking = false;

// Setup UI Event Listeners
function setupUIListeners() {
    // Synchronize HTML sliders to loaded/saved state
    syncSlidersToState();

    // 1. Play / Pause & Frame Stepping
    document.getElementById('btn-play-pause').addEventListener('click', () => {
        setPlaying(!state.playback.isPlaying);
    });

    document.getElementById('btn-step-back').addEventListener('click', () => {
        stepFrame(false);
    });

    document.getElementById('btn-step-fwd').addEventListener('click', () => {
        stepFrame(true);
    });

    // 2. Playback Speeds
    document.querySelectorAll('.btn-group button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const speed = parseFloat(e.target.dataset.speed);
            updatePlaybackSpeed(speed);
        });
    });

    // 2.7. Audio Mute Button
    const btnMute = document.getElementById('btn-mute');
    if (btnMute) {
        btnMute.addEventListener('click', () => {
            toggleMute();
        });
    }

    // 2.9. Sidebar Toggle Button
    const btnSidebarToggle = document.getElementById('sidebar-toggle-btn');
    if (btnSidebarToggle) {
        btnSidebarToggle.addEventListener('click', () => {
            toggleSidebar();
        });
    }

    // 2.5. Telemetry Panel Toggle
    const toggleTelBtn = document.getElementById('btn-toggle-telemetry');
    const telPanel = document.getElementById('telemetry-panel');
    const closeTelBtn = document.getElementById('telemetry-close-btn');
    
    if (toggleTelBtn && telPanel) {
        toggleTelBtn.addEventListener('click', () => {
            isTelemetryVisible = !isTelemetryVisible;
            if (isTelemetryVisible) {
                telPanel.style.display = 'flex';
                toggleTelBtn.classList.add('active');
                
                // Redraw icons if needed
                if (window.lucide) {
                    window.lucide.createIcons();
                }
                
                // Invalidate map size so Leaflet renders correctly after showing container
                if (telMap) {
                    setTimeout(() => {
                        telMap.invalidateSize();
                        if (telPolyline) {
                            telMap.fitBounds(telPolyline.getBounds());
                        }
                    }, 200);
                }
            } else {
                telPanel.style.display = 'none';
                toggleTelBtn.classList.remove('active');
            }
        });
    }
    
    if (closeTelBtn && telPanel && toggleTelBtn) {
        closeTelBtn.addEventListener('click', () => {
            isTelemetryVisible = false;
            telPanel.style.display = 'none';
            toggleTelBtn.classList.remove('active');
        });
    }

    // 3. Timeline Seeking
    const timeline = document.getElementById('timeline-slider');
    timeline.addEventListener('input', (e) => {
        isUserSeeking = true;
        const val = parseFloat(e.target.value);
        const progressPercent = (val / state.playback.duration) * 100;
        document.getElementById('timeline-progress').style.width = `${progressPercent}%`;
        document.getElementById('time-current').textContent = formatTime(val);
    });

    timeline.addEventListener('change', (e) => {
        const val = parseFloat(e.target.value);
        syncTimeTo(val);
        isUserSeeking = false;
    });

    // 4. Driver Camera Toggle
    const driverToggle = document.getElementById('driver-cam-toggle');
    driverToggle.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        if (enabled) {
            if (state.playback.isPlaying) {
                state.cameras.dcamera.el.play().catch(() => {});
            }
            state.cameras.dcamera.el.currentTime = state.playback.currentTime;
        } else {
            state.cameras.dcamera.el.pause();
        }
        
        updateFisheyeProjections();
    });

    // Zoomed-in Camera Toggle
    const narrowToggle = document.getElementById('narrow-cam-toggle');
    narrowToggle.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        if (enabled) {
            if (state.playback.isPlaying) {
                state.cameras.fcamera.el.play().catch(() => {});
            }
            state.cameras.fcamera.el.currentTime = state.playback.currentTime;
        } else {
            state.cameras.fcamera.el.pause();
        }
        
        updateFisheyeProjections();
    });

    // 5. HUD Snap Angles
    // Point camera straight forward (facing forward/road along -Z axis)
    document.getElementById('look-front-btn').addEventListener('click', () => {
        animateCameraLook(0); // facing forward is 0 in OrbitControls
    });

    // Point camera straight backward (facing driver/cabin along +Z axis)
    document.getElementById('look-back-btn').addEventListener('click', () => {
        animateCameraLook(Math.PI); // facing backward is Math.PI (180 deg) in OrbitControls
    });

    // 6. DEVELOPER MODE KEYBOARD / CLICK SHORTCUTS
    document.getElementById('status-indicator').addEventListener('dblclick', toggleDevPanel);
    
    window.addEventListener('keydown', (e) => {
        // Dev Mode Key Toggle
        if (e.key === 'd' || e.key === 'D') {
            toggleDevPanel();
        }

        // Reset Camera Pitch to horizontal
        if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            resetCameraPitch();
        }
        
        // Play/Pause shortcut
        if (e.key === ' ') {
            e.preventDefault();
            setPlaying(!state.playback.isPlaying);
        }
        
        // Mute/Unmute shortcut (M)
        if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            toggleMute();
        }
        
        // Toggle Sidebar shortcut (B)
        if (e.key === 'b' || e.key === 'B') {
            e.preventDefault();
            toggleSidebar();
        }
        
        // Frame step backward shortcut (Left Arrow or Comma)
        if (e.key === 'ArrowLeft' || e.key === ',') {
            e.preventDefault();
            stepFrame(false);
        }
        
        // Frame step forward shortcut (Right Arrow or Period)
        if (e.key === 'ArrowRight' || e.key === '.') {
            e.preventDefault();
            stepFrame(true);
        }

        // --- DEV MODE KEYBOARD OVERLAPS ---
        if (state.calibration.devMode) {
            if (e.key === 'q' || e.key === 'Q') {
                combinedMaterial.uniforms.u_overlap_mode.value = 1.0; // 50/50 Mix
            }
            if (e.key === 'w' || e.key === 'W') {
                combinedMaterial.uniforms.u_overlap_mode.value = 2.0; // Driver Priority
            }
        }
    });

    window.addEventListener('keyup', (e) => {
        // Reset overlap mode to Front priority (0.0) when releasing Q or W keys
        if (e.key === 'q' || e.key === 'Q' || e.key === 'w' || e.key === 'W') {
            if (combinedMaterial) {
                combinedMaterial.uniforms.u_overlap_mode.value = 0.0; // Front Priority
            }
        }
    });

    // Developer Sliders Listeners
    // Front Yaw
    const frontYawSlider = document.getElementById('front-yaw');
    frontYawSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        state.calibration.frontYaw = val;
        document.getElementById('front-yaw-value').textContent = `${val}°`;
        updateFisheyeProjections();
    });

    // Front Pitch
    const frontPitchSlider = document.getElementById('front-pitch');
    frontPitchSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontPitch = val;
        document.getElementById('front-pitch-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Front Roll
    const frontRollSlider = document.getElementById('front-roll');
    frontRollSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontRoll = val;
        document.getElementById('front-roll-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Front Focal
    const frontFocalSlider = document.getElementById('front-focal');
    frontFocalSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontFocal = val;
        document.getElementById('front-focal-value').textContent = val.toFixed(2);
        updateFisheyeProjections();
    });

    // Front Max Theta
    const frontMaxThetaSlider = document.getElementById('front-max-theta');
    frontMaxThetaSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontMaxTheta = val;
        document.getElementById('front-max-theta-value').textContent = `${val}°`;
        updateFisheyeProjections();
    });

    // Front Max Theta Bias
    const frontMaxThetaBiasSlider = document.getElementById('front-max-theta-bias');
    frontMaxThetaBiasSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontMaxThetaBias = val;
        document.getElementById('front-max-theta-bias-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Narrow Yaw
    const narrowYawSlider = document.getElementById('narrow-yaw');
    narrowYawSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        state.calibration.narrowYaw = val;
        document.getElementById('narrow-yaw-value').textContent = `${val}°`;
        updateFisheyeProjections();
    });

    // Narrow Pitch
    const narrowPitchSlider = document.getElementById('narrow-pitch');
    narrowPitchSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowPitch = val;
        document.getElementById('narrow-pitch-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Narrow Roll
    const narrowRollSlider = document.getElementById('narrow-roll');
    narrowRollSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowRoll = val;
        document.getElementById('narrow-roll-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Narrow Focal
    const narrowFocalSlider = document.getElementById('narrow-focal');
    narrowFocalSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowFocal = val;
        document.getElementById('narrow-focal-value').textContent = val.toFixed(2);
        updateFisheyeProjections();
    });

    // Narrow Max Theta
    const narrowMaxThetaSlider = document.getElementById('narrow-max-theta');
    narrowMaxThetaSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowMaxTheta = val;
        document.getElementById('narrow-max-theta-value').textContent = `${val}°`;
        updateFisheyeProjections();
    });

    // Driver Yaw
    const driverYawSlider = document.getElementById('driver-yaw');
    driverYawSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        state.calibration.driverYaw = val;
        document.getElementById('driver-yaw-value').textContent = `${val}°`;
        updateFisheyeProjections();
    });

    // Driver Pitch
    const driverPitchSlider = document.getElementById('driver-pitch');
    driverPitchSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverPitch = val;
        document.getElementById('driver-pitch-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Driver Roll
    const driverRollSlider = document.getElementById('driver-roll');
    driverRollSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverRoll = val;
        document.getElementById('driver-roll-value').textContent = `${val >= 0 ? '+' : ''}${val}°`;
        updateFisheyeProjections();
    });

    // Driver Focal
    const driverFocalSlider = document.getElementById('driver-focal');
    driverFocalSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverFocal = val;
        document.getElementById('driver-focal-value').textContent = val.toFixed(2);
        updateFisheyeProjections();
    });

    // Driver Max Theta
    const driverMaxThetaSlider = document.getElementById('driver-max-theta');
    driverMaxThetaSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverMaxTheta = val;
        document.getElementById('driver-max-theta-value').textContent = `${val}°`;
        updateFisheyeProjections();
    });

    // Sphere Radius
    const radiusSlider = document.getElementById('proj-radius');
    radiusSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.radius = val;
        document.getElementById('proj-radius-value').textContent = `${val.toFixed(1)}m`;
        updateFisheyeProjections();
    });

    // Front Pan X, Y, Z
    document.getElementById('front-pan-x').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontPanX = val;
        document.getElementById('front-pan-x-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });
    document.getElementById('front-pan-y').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontPanY = val;
        document.getElementById('front-pan-y-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });
    document.getElementById('front-pan-z').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.frontPanZ = val;
        document.getElementById('front-pan-z-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });

    // Narrow Pan X, Y, Z
    document.getElementById('narrow-pan-x').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowPanX = val;
        document.getElementById('narrow-pan-x-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });
    document.getElementById('narrow-pan-y').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowPanY = val;
        document.getElementById('narrow-pan-y-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });
    document.getElementById('narrow-pan-z').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.narrowPanZ = val;
        document.getElementById('narrow-pan-z-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });

    // Driver Pan X, Y, Z
    document.getElementById('driver-pan-x').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverPanX = val;
        document.getElementById('driver-pan-x-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });
    document.getElementById('driver-pan-y').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverPanY = val;
        document.getElementById('driver-pan-y-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });
    document.getElementById('driver-pan-z').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.calibration.driverPanZ = val;
        document.getElementById('driver-pan-z-value').textContent = `${val >= 0 ? '+' : ''}${val} cm`;
        updateFisheyeProjections();
    });

    // Reset Calibration Button
    document.getElementById('reset-calibration').addEventListener('click', () => {
        state.calibration.frontYaw = 180;
        state.calibration.frontPitch = 6.5;
        state.calibration.frontRoll = 0;
        state.calibration.frontFocal = 0.29;
        state.calibration.frontMaxTheta = 86.0;
        state.calibration.frontMaxThetaBias = 6.0;
        state.calibration.frontPanX = -20.0;
        state.calibration.frontPanY = 0.0;
        state.calibration.frontPanZ = 0.0;
        
        state.calibration.narrowYaw = 180;
        state.calibration.narrowPitch = 4.5;
        state.calibration.narrowRoll = 0;
        state.calibration.narrowFocal = 1.22;
        state.calibration.narrowMaxTheta = 40.0;
        state.calibration.narrowPanX = 1.5;
        state.calibration.narrowPanY = 0.0;
        state.calibration.narrowPanZ = 0.0;

        state.calibration.driverYaw = 0;
        state.calibration.driverPitch = 14.0;
        state.calibration.driverRoll = 0;
        state.calibration.driverFocal = 0.29;
        state.calibration.driverMaxTheta = 92.0;
        state.calibration.driverPanX = 0.0;
        state.calibration.driverPanY = -43.5;
        state.calibration.driverPanZ = 3.0;
        
        state.calibration.radius = 10.0;

        syncSlidersToState();
        updateFisheyeProjections();
    });

    // Export Calibration Button
    document.getElementById('export-calibration').addEventListener('click', () => {
        const config = {
            frontYaw: state.calibration.frontYaw,
            frontPitch: state.calibration.frontPitch,
            frontRoll: state.calibration.frontRoll,
            frontFocal: state.calibration.frontFocal,
            frontMaxTheta: state.calibration.frontMaxTheta,
            frontMaxThetaBias: state.calibration.frontMaxThetaBias,
            frontPanX: state.calibration.frontPanX,
            frontPanY: state.calibration.frontPanY,
            frontPanZ: state.calibration.frontPanZ,
            
            narrowYaw: state.calibration.narrowYaw,
            narrowPitch: state.calibration.narrowPitch,
            narrowRoll: state.calibration.narrowRoll,
            narrowFocal: state.calibration.narrowFocal,
            narrowMaxTheta: state.calibration.narrowMaxTheta,
            narrowPanX: state.calibration.narrowPanX,
            narrowPanY: state.calibration.narrowPanY,
            narrowPanZ: state.calibration.narrowPanZ,
            
            driverYaw: state.calibration.driverYaw,
            driverPitch: state.calibration.driverPitch,
            driverRoll: state.calibration.driverRoll,
            driverFocal: state.calibration.driverFocal,
            driverMaxTheta: state.calibration.driverMaxTheta,
            driverPanX: state.calibration.driverPanX,
            driverPanY: state.calibration.driverPanY,
            driverPanZ: state.calibration.driverPanZ,
            
            radius: state.calibration.radius
        };
        const text = JSON.stringify(config, null, 2);
        
        const handleCopySuccess = () => {
            const btn = document.getElementById('export-calibration');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="check" style="width: 14px; height: 14px;"></i> Copied!';
            if (window.lucide) {
                window.lucide.createIcons();
            }
            setTimeout(() => {
                btn.innerHTML = originalText;
                if (window.lucide) {
                    window.lucide.createIcons();
                }
            }, 1500);
        };

        const fallbackCopy = (str) => {
            const textArea = document.createElement("textarea");
            textArea.value = str;
            textArea.style.position = "fixed";
            textArea.style.top = "0";
            textArea.style.left = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                const successful = document.execCommand('copy');
                if (successful) {
                    handleCopySuccess();
                } else {
                    alert('Could not copy to clipboard. Check browser permissions.');
                }
            } catch (err) {
                console.error('Fallback copy error:', err);
                alert('Could not copy to clipboard. Check browser permissions.');
            }
            document.body.removeChild(textArea);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(handleCopySuccess).catch(err => {
                console.warn('navigator.clipboard failed, using fallback:', err);
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    });
}

function toggleDevPanel() {
    const devPanel = document.getElementById('developer-panel');
    if (devPanel) {
        const isHidden = devPanel.style.display === 'none';
        devPanel.style.display = isHidden ? 'block' : 'none';
        state.calibration.devMode = isHidden; // Sync state dev flag

        // Update dev guide lines visibility
        if (horizonLine) horizonLine.visible = state.calibration.devMode;
        if (verticalLine) verticalLine.visible = state.calibration.devMode;

        // If disabling dev mode, force overlap mode to reset to front priority
        if (!isHidden && combinedMaterial) {
            combinedMaterial.uniforms.u_overlap_mode.value = 0.0;
        }
        
        // Scroll sidebar to bottom if showing dev panel
        if (isHidden) {
            const scrollContainer = document.querySelector('.sidebar-scrollable');
            setTimeout(() => {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }, 50);
        }
    }
}

// Camera Rotation Animation Helper
function animateCameraLook(targetYaw) {
    const startAzimuth = controls.getAzimuthalAngle();
    const startPolar = controls.getPolarAngle();
    const targetAzimuth = targetYaw;
    const targetPolar = Math.PI / 2;

    const duration = 300;
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        
        let diff = targetAzimuth - startAzimuth;
        if (diff > Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;

        const currentAzimuth = startAzimuth + diff * ease;
        const currentPolar = startPolar + (targetPolar - startPolar) * ease;

        controls.minAzimuthAngle = currentAzimuth;
        controls.maxAzimuthAngle = currentAzimuth;
        controls.minPolarAngle = currentPolar;
        controls.maxPolarAngle = currentPolar;
        
        controls.update();

        controls.minAzimuthAngle = -Infinity;
        controls.maxAzimuthAngle = Infinity;
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI;

        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }
    
    requestAnimationFrame(step);
}

// Resize event
function onWindowResize() {
    const container = document.getElementById('three-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
}

// Calculate dynamic maximum FOV to support wide landscape-equivalent viewports in portrait mode
function getMaxFov() {
    if (!camera) return 100;
    if (camera.aspect < 1) {
        // Scale max vertical FOV proportionally, capping at 140 to avoid rendering bugs/extremes
        return Math.min(140, 100 / camera.aspect);
    }
    return 100;
}

// Diagnostics timer
let lastSyncCheck = 0;

// Main Render & Animation Loop
function animate(time) {
    requestAnimationFrame(animate);

    controls.update();
    updateCompassDisplay();
    updateTelemetryDisplay();

    // Check sync every 150ms
    if (time - lastSyncCheck > 150) {
        runSyncDiagnostics();
        lastSyncCheck = time;
    }

    renderer.render(scene, camera);
}

// Calculate camera rotation yaw and display compass HUD
// Yaw is mapped relative to the forward direction (Math.PI / 180 deg in OrbitControls)
function updateCompassDisplay() {
    if (!camera) return;

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    
    // yawRad is 0 when looking along +Z (backward/driver)
    // We want 0 heading to be looking along -Z (forward)
    // So we rotate by Math.PI
    let yawRad = Math.atan2(dir.x, -dir.z); 
    let yawDeg = THREE.MathUtils.radToDeg(yawRad);
    if (yawDeg < 0) yawDeg += 360;

    // Get vehicle's current bearing from telemetry
    let vehicleBearing = 0; // Default to North (0) if not available
    let hasGpsHeading = false;
    
    if (state.playback.telemetry && state.playback.telemetry.length > 0) {
        const t = state.playback.currentTime;
        let bestPoint = state.playback.telemetry[0];
        let minDiff = Math.abs(bestPoint.time - t);
        
        for (let i = 1; i < state.playback.telemetry.length; i++) {
            const diff = Math.abs(state.playback.telemetry[i].time - t);
            if (diff < minDiff) {
                minDiff = diff;
                bestPoint = state.playback.telemetry[i];
            } else if (diff > minDiff) {
                break;
            }
        }
        
        if (bestPoint && bestPoint.bearing !== null && bestPoint.bearing !== undefined) {
            vehicleBearing = bestPoint.bearing;
            hasGpsHeading = true;
        }
    }

    // Combined true heading = (vehicle bearing + camera yaw) % 360
    if (hasGpsHeading) {
        let trueHeading = (vehicleBearing + yawDeg) % 360;
        if (trueHeading < 0) trueHeading += 360;

        document.getElementById('compass-yaw').textContent = `${trueHeading.toFixed(1)}°`;

        let direction = "N";
        if (trueHeading >= 22.5 && trueHeading < 67.5) direction = "NE";
        else if (trueHeading >= 67.5 && trueHeading < 112.5) direction = "E";
        else if (trueHeading >= 112.5 && trueHeading < 157.5) direction = "SE";
        else if (trueHeading >= 157.5 && trueHeading < 202.5) direction = "S";
        else if (trueHeading >= 202.5 && trueHeading < 247.5) direction = "SW";
        else if (trueHeading >= 247.5 && trueHeading < 292.5) direction = "W";
        else if (trueHeading >= 292.5 && trueHeading < 337.5) direction = "NW";

        document.getElementById('compass-dir').textContent = direction;
    } else {
        document.getElementById('compass-yaw').textContent = "--";
        document.getElementById('compass-dir').textContent = "--";
    }
    
    // Update the compass panel label to "TRUE HEADING" if GPS is active
    const labelEl = document.querySelector('.compass-panel .hud-label');
    if (labelEl) {
        labelEl.textContent = hasGpsHeading ? "TRUE HEADING" : "HEADING";
    }
}

// Local Storage Persistence Helpers
function saveCalibrationToStorage() {
    localStorage.setItem('comma_360_calibration', JSON.stringify({
        frontYaw: state.calibration.frontYaw,
        frontPitch: state.calibration.frontPitch,
        frontRoll: state.calibration.frontRoll,
        frontFocal: state.calibration.frontFocal,
        frontMaxTheta: state.calibration.frontMaxTheta,
        frontPanX: state.calibration.frontPanX,
        frontPanY: state.calibration.frontPanY,
        frontPanZ: state.calibration.frontPanZ,
        narrowYaw: state.calibration.narrowYaw,
        narrowPitch: state.calibration.narrowPitch,
        narrowRoll: state.calibration.narrowRoll,
        narrowFocal: state.calibration.narrowFocal,
        narrowMaxTheta: state.calibration.narrowMaxTheta,
        narrowPanX: state.calibration.narrowPanX,
        narrowPanY: state.calibration.narrowPanY,
        narrowPanZ: state.calibration.narrowPanZ,
        driverYaw: state.calibration.driverYaw,
        driverPitch: state.calibration.driverPitch,
        driverRoll: state.calibration.driverRoll,
        driverFocal: state.calibration.driverFocal,
        driverMaxTheta: state.calibration.driverMaxTheta,
        driverPanX: state.calibration.driverPanX,
        driverPanY: state.calibration.driverPanY,
        driverPanZ: state.calibration.driverPanZ,
        radius: state.calibration.radius
    }));
}

function loadCalibrationFromStorage() {
    const saved = localStorage.getItem('comma_360_calibration');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            Object.keys(parsed).forEach(key => {
                if (state.calibration[key] !== undefined) {
                    state.calibration[key] = parsed[key];
                }
            });
        } catch (e) {
            console.warn("Failed to load saved calibration:", e);
        }
    }
}

function syncSlidersToState() {
    // Front Camera Inputs
    document.getElementById('front-yaw').value = state.calibration.frontYaw;
    document.getElementById('front-yaw-value').textContent = `${state.calibration.frontYaw}°`;
    
    document.getElementById('front-pitch').value = state.calibration.frontPitch;
    document.getElementById('front-pitch-value').textContent = `${state.calibration.frontPitch >= 0 ? '+' : ''}${state.calibration.frontPitch}°`;
    
    document.getElementById('front-roll').value = state.calibration.frontRoll;
    document.getElementById('front-roll-value').textContent = `${state.calibration.frontRoll >= 0 ? '+' : ''}${state.calibration.frontRoll}°`;
    
    document.getElementById('front-focal').value = state.calibration.frontFocal;
    document.getElementById('front-focal-value').textContent = state.calibration.frontFocal.toFixed(2);

    document.getElementById('front-max-theta').value = state.calibration.frontMaxTheta;
    document.getElementById('front-max-theta-value').textContent = `${state.calibration.frontMaxTheta}°`;

    document.getElementById('front-max-theta-bias').value = state.calibration.frontMaxThetaBias;
    document.getElementById('front-max-theta-bias-value').textContent = `${state.calibration.frontMaxThetaBias >= 0 ? '+' : ''}${state.calibration.frontMaxThetaBias}°`;

    document.getElementById('front-pan-x').value = state.calibration.frontPanX;
    document.getElementById('front-pan-x-value').textContent = `${state.calibration.frontPanX >= 0 ? '+' : ''}${state.calibration.frontPanX} cm`;
    document.getElementById('front-pan-y').value = state.calibration.frontPanY;
    document.getElementById('front-pan-y-value').textContent = `${state.calibration.frontPanY >= 0 ? '+' : ''}${state.calibration.frontPanY} cm`;
    document.getElementById('front-pan-z').value = state.calibration.frontPanZ;
    document.getElementById('front-pan-z-value').textContent = `${state.calibration.frontPanZ >= 0 ? '+' : ''}${state.calibration.frontPanZ} cm`;

    // Zoomed-in Camera Inputs
    document.getElementById('narrow-yaw').value = state.calibration.narrowYaw;
    document.getElementById('narrow-yaw-value').textContent = `${state.calibration.narrowYaw}°`;
    
    document.getElementById('narrow-pitch').value = state.calibration.narrowPitch;
    document.getElementById('narrow-pitch-value').textContent = `${state.calibration.narrowPitch >= 0 ? '+' : ''}${state.calibration.narrowPitch}°`;
    
    document.getElementById('narrow-roll').value = state.calibration.narrowRoll;
    document.getElementById('narrow-roll-value').textContent = `${state.calibration.narrowRoll >= 0 ? '+' : ''}${state.calibration.narrowRoll}°`;
    
    document.getElementById('narrow-focal').value = state.calibration.narrowFocal;
    document.getElementById('narrow-focal-value').textContent = state.calibration.narrowFocal.toFixed(2);

    document.getElementById('narrow-max-theta').value = state.calibration.narrowMaxTheta;
    document.getElementById('narrow-max-theta-value').textContent = `${state.calibration.narrowMaxTheta}°`;

    document.getElementById('narrow-pan-x').value = state.calibration.narrowPanX;
    document.getElementById('narrow-pan-x-value').textContent = `${state.calibration.narrowPanX >= 0 ? '+' : ''}${state.calibration.narrowPanX} cm`;
    document.getElementById('narrow-pan-y').value = state.calibration.narrowPanY;
    document.getElementById('narrow-pan-y-value').textContent = `${state.calibration.narrowPanY >= 0 ? '+' : ''}${state.calibration.narrowPanY} cm`;
    document.getElementById('narrow-pan-z').value = state.calibration.narrowPanZ;
    document.getElementById('narrow-pan-z-value').textContent = `${state.calibration.narrowPanZ >= 0 ? '+' : ''}${state.calibration.narrowPanZ} cm`;
    
    // Driver Camera Inputs
    document.getElementById('driver-yaw').value = state.calibration.driverYaw;
    document.getElementById('driver-yaw-value').textContent = `${state.calibration.driverYaw}°`;
    
    document.getElementById('driver-pitch').value = state.calibration.driverPitch;
    document.getElementById('driver-pitch-value').textContent = `${state.calibration.driverPitch >= 0 ? '+' : ''}${state.calibration.driverPitch}°`;
    
    document.getElementById('driver-roll').value = state.calibration.driverRoll;
    document.getElementById('driver-roll-value').textContent = `${state.calibration.driverRoll >= 0 ? '+' : ''}${state.calibration.driverRoll}°`;
    
    document.getElementById('driver-focal').value = state.calibration.driverFocal;
    document.getElementById('driver-focal-value').textContent = state.calibration.driverFocal.toFixed(2);

    document.getElementById('driver-max-theta').value = state.calibration.driverMaxTheta;
    document.getElementById('driver-max-theta-value').textContent = `${state.calibration.driverMaxTheta}°`;

    document.getElementById('driver-pan-x').value = state.calibration.driverPanX;
    document.getElementById('driver-pan-x-value').textContent = `${state.calibration.driverPanX >= 0 ? '+' : ''}${state.calibration.driverPanX} cm`;
    document.getElementById('driver-pan-y').value = state.calibration.driverPanY;
    document.getElementById('driver-pan-y-value').textContent = `${state.calibration.driverPanY >= 0 ? '+' : ''}${state.calibration.driverPanY} cm`;
    document.getElementById('driver-pan-z').value = state.calibration.driverPanZ;
    document.getElementById('driver-pan-z-value').textContent = `${state.calibration.driverPanZ >= 0 ? '+' : ''}${state.calibration.driverPanZ} cm`;
    
    // Global Settings
    document.getElementById('proj-radius').value = state.calibration.radius;
    document.getElementById('proj-radius-value').textContent = `${state.calibration.radius.toFixed(1)}m`;
}

// Frame stepping logic (25 fps driving logs)
const FRAME_TIME = 1 / 25; // 0.04s per frame

function stepFrame(forward = true) {
    if (state.playback.isPlaying) {
        setPlaying(false);
    }
    
    let targetTime = state.playback.currentTime + (forward ? FRAME_TIME : -FRAME_TIME);
    targetTime = Math.max(0, Math.min(state.playback.duration, targetTime));
    
    syncTimeTo(targetTime);
}

// Create semi-transparent horizon guide line
function createHorizonLine() {
    const points = [];
    const segments = 128;
    // Set radius slightly inside the projection spheres (radius 10) to prevent occlusion/z-fighting
    const radius = 9.8; 
    
    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius));
    }
    
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
        color: 0x00f0ff, // Neon cyan to match compass/dev theme
        transparent: true,
        opacity: 0.35,
        linewidth: 1
    });
    
    horizonLine = new THREE.LineLoop(lineGeo, lineMat);
    horizonLine.visible = state.calibration.devMode;
    scene.add(horizonLine);
}

// Create semi-transparent vertical left-right guide line
function createVerticalLeftRightLine() {
    const points = [];
    const segments = 128;
    const radius = 9.79; // Slightly different to prevent z-fighting with horizon line and sphere
    
    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        // Vertically oriented circle in Z = 0 plane
        points.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
    }
    
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.35,
        linewidth: 1
    });
    
    verticalLine = new THREE.LineLoop(lineGeo, lineMat);
    verticalLine.visible = state.calibration.devMode;
    scene.add(verticalLine);
}

// Reset camera polar angle to horizontal (Math.PI / 2) while maintaining current azimuth yaw
function resetCameraPitch() {
    if (!controls) return;
    
    const startPolar = controls.getPolarAngle();
    const targetPolar = Math.PI / 2; // Exactly horizontal (90 degrees)
    const startAzimuth = controls.getAzimuthalAngle();

    const duration = 250; // fast 250ms snap
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic

        const currentPolar = startPolar + (targetPolar - startPolar) * ease;

        // Constraint OrbitControls rotation temporarily to force interpolation
        controls.minAzimuthAngle = startAzimuth;
        controls.maxAzimuthAngle = startAzimuth;
        controls.minPolarAngle = currentPolar;
        controls.maxPolarAngle = currentPolar;
        
        controls.update();

        // Release restrictions
        controls.minAzimuthAngle = -Infinity;
        controls.maxAzimuthAngle = Infinity;
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI;

        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }
    requestAnimationFrame(step);
}

// Fetch available routes and populate dropdown
async function initRouteSelector() {
    const selector = document.getElementById('route-selector');
    if (!selector) return;

    let routes = [];
    try {
        const res = await fetch('routes.json?_t=' + Date.now());
        if (res.ok) {
            routes = await res.json();
        }
    } catch (e) {
        console.warn("Could not load routes.json", e);
    }

    // Normalize routes to an array of objects to handle both flat string arrays (cached) and objects
    state.routesList = routes.map(route => {
        if (typeof route === 'object' && route !== null) {
            return route;
        }
        let type = 'h264 mp4';
        if (route === '00000026--93a24779ed--5') type = 'hevc mp4';
        if (route === '00000026--93a24779ed--6') type = 'hevc mp4';
        return { name: route, type: type };
    });

    // Populate dropdown
    selector.innerHTML = '';
    
    if (state.routesList.length === 0) {
        const option = document.createElement('option');
        option.value = "";
        option.textContent = "No routes found";
        selector.appendChild(option);
        
        updateVideoSourceLabel('');
        
        // Show loading/empty overlay with instructions
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            const overlayText = overlay.querySelector('.loading-text');
            if (overlayText) {
                overlayText.innerHTML = 'No route data found.<br><span style="font-size: 14px; color: var(--text-muted);">Please place route folders in the data directory.</span>';
            }
            const spinner = overlay.querySelector('.spinner');
            if (spinner) spinner.style.display = 'none';
        }
        return;
    }

    state.routesList.forEach(route => {
        const option = document.createElement('option');
        option.value = route.name;
        
        let displayName = route.name;
        if (route.name.includes('--')) {
            const cleanName = route.name.includes('/') ? route.name.split('/').pop() : route.name;
            const parts = cleanName.split('--');
            if (parts.length >= 3) {
                displayName = `Segment ${parts[2]} (${parts[1]})`;
            }
        } else if (route.name === 'car-fire' || route.name.endsWith('car-fire')) {
            displayName = '🔥 Car Fire Demo';
        }
        
        if (route.start_time) {
            displayName += ` (${route.start_time})`;
        }
        
        option.textContent = displayName;
        selector.appendChild(option);
    });

    // Check if there is a saved route in localStorage
    const savedRoute = localStorage.getItem('comma_360_selected_route');
    const savedExists = state.routesList.some(r => r.name === savedRoute);
    const activeRoute = savedExists ? savedRoute : state.routesList[0].name;

    selector.value = activeRoute;
    
    // Update video/audio sources in DOM before setupVideos loads them
    const camFiles = {
        ecamera: 'ecamera.mp4',
        dcamera: 'dcamera.mp4',
        fcamera: 'fcamera.mp4'
    };
    Object.keys(camFiles).forEach(key => {
        const video = document.getElementById(`video-${key}`);
        if (video) {
            video.src = `${activeRoute}/${camFiles[key]}`;
        }
    });

    const audio = document.getElementById('audio-track');
    if (audio) {
        audio.src = `${activeRoute}/qcamera.m4a`;
    }

    updateVideoSourceLabel(activeRoute);

    // Initial telemetry fetch
    fetchTelemetry(activeRoute);

    // Handle change event
    selector.addEventListener('change', (e) => {
        loadRoute(e.target.value);
    });
}

// Update the video source description label in UI
function updateVideoSourceLabel(routeName) {
    const labelEl = document.getElementById('metric-video-source');
    if (!labelEl) return;

    const route = state.routesList?.find(r => r.name === routeName);
    if (route) {
        labelEl.textContent = route.type;
        
        // Color code for a premium look
        if (route.type === 'h264 mp4') {
            labelEl.style.color = '#34c759'; // Neon green
        } else if (route.type === 'hevc mp4') {
            labelEl.style.color = '#00f0ff'; // Neon cyan
        } else if (route.type === 'raw hevc stream') {
            labelEl.style.color = '#ffcc00'; // Neon yellow
        }
    } else {
        labelEl.textContent = 'unknown';
        labelEl.style.color = 'var(--text-muted)';
    }
}

// Switches the active route, resets state, and reloads video streams
function loadRoute(routeName) {
    console.log(`Switching route to: ${routeName}`);
    localStorage.setItem('comma_360_selected_route', routeName);
    
    updateVideoSourceLabel(routeName);
    
    // Show loading overlay
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        
        // Reset spinner and text in case of previous load errors
        const spinner = overlay.querySelector('.loader-spinner');
        if (spinner) spinner.style.display = 'block';
        const textEl = overlay.querySelector('.loader-text');
        if (textEl) textEl.textContent = 'Loading camera feeds...';
    }

    // Pause playback
    setPlaying(false);

    // Mark cameras as not loaded
    Object.keys(state.cameras).forEach(k => {
        state.cameras[k].loaded = false;
    });

    const camFiles = {
        ecamera: 'ecamera.mp4',
        dcamera: 'dcamera.mp4',
        fcamera: 'fcamera.mp4'
    };

    Object.keys(camFiles).forEach(key => {
        const video = state.cameras[key].el;
        if (video) {
            video.src = `${routeName}/${camFiles[key]}`;
            video.load();
        }
    });

    const audio = document.getElementById('audio-track');
    if (audio) {
        audio.src = `${routeName}/qcamera.m4a`;
        audio.load();
    }

    // Reset timeline slider and playback current time
    state.playback.currentTime = 0;
    const timeline = document.getElementById('timeline-slider');
    if (timeline) {
        timeline.value = 0;
    }
    const timelineProgress = document.getElementById('timeline-progress');
    if (timelineProgress) {
        timelineProgress.style.width = '0%';
    }
    const currentTimeText = document.getElementById('time-current');
    if (currentTimeText) {
        currentTimeText.textContent = '00:00';
    }

    // Fetch telemetry data for the new route
    fetchTelemetry(routeName);
}

// Fetch telemetry data from the server in memory
async function fetchTelemetry(routeName) {
    state.playback.telemetry = null;
    
    // Hide map container initially
    const mapContainer = document.getElementById('tel-map-container');
    if (mapContainer) mapContainer.style.display = 'none';

    try {
        const res = await fetch(`telemetry/${routeName}.json?_t=${Date.now()}`);
        if (res.ok) {
            const data = await res.json();
            state.playback.telemetry = data;
            console.log(`[Telemetry] Loaded ${data.length} data points for route ${routeName}`);
            
            // Check if we have valid GPS data points
            const hasGps = data.some(pt => pt.lat !== null && pt.lng !== null);
            if (hasGps) {
                if (mapContainer) mapContainer.style.display = 'block';
                // Delay slightly to let Leaflet map container mount and initialize
                setTimeout(() => {
                    initTelemetryMap(data);
                }, 100);
            }
        } else {
            console.warn(`[Telemetry] Telemetry not available for route ${routeName}`);
        }
    } catch (e) {
        console.error(`[Telemetry] Error fetching telemetry:`, e);
    }
}

// Initialize Leaflet map with route coordinates and marker
function initTelemetryMap(data) {
    // Collect all valid GPS coordinates
    const path = data
        .filter(pt => pt.lat !== null && pt.lng !== null)
        .map(pt => [pt.lat, pt.lng]);
        
    if (path.length === 0) return;
    
    // If map already exists, update its trace instead of recreating
    if (telMap) {
        if (telPolyline) telPolyline.setLatLngs(path);
        if (telMarker) telMarker.setLatLng(path[0]);
        telMap.fitBounds(telPolyline.getBounds());
        telMap.invalidateSize();
        return;
    }
    
    try {
        // Create Leaflet map container
        telMap = L.map('telemetry-map', {
            zoomControl: false,
            attributionControl: false
        }).setView(path[0], 15);
        
        // Add dark theme tile layer (using CartoDB Dark Matter)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(telMap);
        
        // Add path polyline
        telPolyline = L.polyline(path, {
            color: '#00f0ff',
            weight: 3,
            opacity: 0.8
        }).addTo(telMap);
        
        // Add current location marker
        telMarker = L.circleMarker(path[0], {
            color: '#34c759',
            fillColor: '#34c759',
            fillOpacity: 1.0,
            radius: 6
        }).addTo(telMap);
        
        // Fit map bounds
        telMap.fitBounds(telPolyline.getBounds());
        
        setTimeout(() => {
            telMap.invalidateSize();
        }, 100);
    } catch (err) {
        console.error("[Telemetry Map] Error creating leaflet map:", err);
    }
}

// Synchronizes UI components with active telemetry frame
function updateTelemetryDisplay() {
    if (!state.playback.telemetry || state.playback.telemetry.length === 0 || !isTelemetryVisible) {
        return;
    }

    const t = state.playback.currentTime;
    
    // Find telemetry point closest to currentTime
    let bestPoint = state.playback.telemetry[0];
    let minDiff = Math.abs(bestPoint.time - t);
    
    for (let i = 1; i < state.playback.telemetry.length; i++) {
        const diff = Math.abs(state.playback.telemetry[i].time - t);
        if (diff < minDiff) {
            minDiff = diff;
            bestPoint = state.playback.telemetry[i];
        } else if (diff > minDiff) {
            break; // Sorted array, stop searching
        }
    }
    
    if (bestPoint) {
        // 1. Update Speed: convert m/s to MPH (1 m/s = 2.23694 mph)
        const speedMph = (bestPoint.speed * 2.23694).toFixed(1);
        const speedEl = document.getElementById('tel-speed');
        if (speedEl) speedEl.textContent = speedMph;
        
        // 2. Update Steering Wheel rotation
        const steeringWheel = document.getElementById('tel-steering-wheel');
        if (steeringWheel) {
            steeringWheel.style.transform = `rotate(${-bestPoint.steering_angle}deg)`;
        }
        const steeringAngleEl = document.getElementById('tel-steering');
        if (steeringAngleEl) steeringAngleEl.textContent = `${Math.round(bestPoint.steering_angle)}°`;
        
        // 3. Update Pedals indicators
        const gasEl = document.getElementById('tel-pedal-gas');
        if (gasEl) {
            if (bestPoint.gas) {
                gasEl.classList.add('active-gas');
            } else {
                gasEl.classList.remove('active-gas');
            }
        }
        
        const brakeEl = document.getElementById('tel-pedal-brake');
        if (brakeEl) {
            if (bestPoint.brake) {
                brakeEl.classList.add('active-brake');
            } else {
                brakeEl.classList.remove('active-brake');
            }
        }
        
        // 4. Update Gear
        const gearEl = document.getElementById('tel-gear');
        if (gearEl) {
            let gearText = bestPoint.gear;
            if (gearText === 'drive') gearText = 'D';
            else if (gearText === 'park') gearText = 'P';
            else if (gearText === 'reverse') gearText = 'R';
            else if (gearText === 'neutral') gearText = 'N';
            else if (gearText === 'unknown') gearText = '--';
            gearEl.textContent = gearText;
        }
        
        // 5. Update blinkers (blink active signal at 2.5Hz)
        const blinkerLEl = document.getElementById('tel-blinker-l');
        if (blinkerLEl) {
            if (bestPoint.left_blinker && Math.floor(t * 2.5) % 2 === 0) {
                blinkerLEl.classList.add('active');
            } else {
                blinkerLEl.classList.remove('active');
            }
        }
        
        const blinkerREl = document.getElementById('tel-blinker-r');
        if (blinkerREl) {
            if (bestPoint.right_blinker && Math.floor(t * 2.5) % 2 === 0) {
                blinkerREl.classList.add('active');
            } else {
                blinkerREl.classList.remove('active');
            }
        }
        
        // 6. Update Alerts overlay box
        const alertBox = document.getElementById('tel-alert-box');
        if (alertBox) {
            if (bestPoint.alert_text1 || bestPoint.alert_text2) {
                alertBox.style.display = 'flex';
                const titleEl = document.getElementById('tel-alert-title');
                const descEl = document.getElementById('tel-alert-desc');
                if (titleEl) titleEl.textContent = bestPoint.alert_text1 || '';
                if (descEl) descEl.textContent = bestPoint.alert_text2 || '';
                
                if (bestPoint.alert_status === 'critical' || bestPoint.alert_status === 'userPrompt') {
                    alertBox.classList.remove('normal');
                } else {
                    alertBox.classList.add('normal');
                }
            } else {
                alertBox.style.display = 'none';
            }
        }
        
        // 7. Update State & CPU Temperature
        const stateVal = document.getElementById('tel-state');
        if (stateVal) {
            stateVal.textContent = bestPoint.engaged ? 'ENGAGED' : 'DISABLED';
            if (bestPoint.engaged) {
                stateVal.classList.add('engaged');
            } else {
                stateVal.classList.remove('engaged');
            }
        }
        
        const cpuTempEl = document.getElementById('tel-cpu-temp');
        if (cpuTempEl) {
            cpuTempEl.textContent = bestPoint.cpu_temp > 0 ? `${Math.round(bestPoint.cpu_temp)}°C` : '--°C';
        }
        
        // 8. Update GPS coords and Map Marker position
        const gpsCoordsEl = document.getElementById('tel-gps-coords');
        if (gpsCoordsEl) {
            if (bestPoint.lat !== null && bestPoint.lng !== null) {
                gpsCoordsEl.textContent = `${bestPoint.lat.toFixed(5)}, ${bestPoint.lng.toFixed(5)}`;
                
                if (telMap && telMarker) {
                    const latlng = L.latLng(bestPoint.lat, bestPoint.lng);
                    telMarker.setLatLng(latlng);
                    
                    // Pan map if marker moves out of view boundaries
                    if (!telMap.getBounds().contains(latlng)) {
                        telMap.panTo(latlng);
                    }
                }
            } else {
                gpsCoordsEl.textContent = 'NO GPS SIGNAL';
            }
        }
    }
}


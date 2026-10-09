import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
    detectAreaDefects,
    DetectApiResponse,
    getZoneTheme,
} from '../services/defectDetectionApi';
import {
    FrameDetectionOverlay,
    ScanningOverlay,
    DetectionControlsPanel,
} from '../components/DetectionViewer';

// ─── CAMERA METRICS & FRAME TYPES ───────────────────────────────────────────
export interface CameraMetrics {
    width?: number;
    height?: number;
    frameRate?: number;
    aspectRatio?: number;
    facingMode?: string;
    displayAspect?: string;
}

export interface CapturedFrame {
    id: string;
    dataUrl: string;
    frameIndex: number;
    timestamp: number; // ms from scan start
    timeString: string;
    width: number;
    height: number;
    detection?: DetectApiResponse | null;
    isDetecting?: boolean;
    detectionError?: string | null;
}

interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
    focusMode?: string;
    exposureMode?: string;
    torch?: boolean;
    zoom?: number;
}

interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
    torch?: boolean;
    focusMode?: string[];
    exposureMode?: string[];
    zoom?: { min?: number; max?: number } | number;
}

interface CameraCaptureProps {
    onCaptureFrames: (frames: CapturedFrame[]) => void;
    onClose: () => void;
    onFrameDetected?: (frameId: string, detection: DetectApiResponse) => void;
    onFrameDetectionError?: (frameId: string, error: string) => void;
}

// Format aspect ratio helper for display (e.g. "9:16", "3:4", etc.)
const formatAspectRatio = (width?: number, height?: number, rawAspect?: number): string => {
    if (!width || !height) {
        if (rawAspect) {
            if (Math.abs(rawAspect - 9 / 16) < 0.05) return '9:16';
            if (Math.abs(rawAspect - 3 / 4) < 0.05) return '3:4';
            if (Math.abs(rawAspect - 16 / 9) < 0.05) return '16:9';
            if (Math.abs(rawAspect - 4 / 3) < 0.05) return '4:3';
            return rawAspect.toFixed(2);
        }
        return 'Adaptive';
    }

    const ratio = width / height;
    if (Math.abs(ratio - 9 / 16) < 0.03) return '9:16';
    if (Math.abs(ratio - 3 / 4) < 0.03) return '3:4';
    if (Math.abs(ratio - 16 / 9) < 0.03) return '16:9';
    if (Math.abs(ratio - 4 / 3) < 0.03) return '4:3';
    if (Math.abs(ratio - 1) < 0.03) return '1:1';
    return ratio < 1 ? `${width}:${height} (${ratio.toFixed(2)})` : `${height}:${width} (${ratio.toFixed(2)})`;
};

// ─── CAMERA STREAM ACQUISITION ───────────────────────────────────────────────
async function acquireAdaptiveCameraStreamAndroid(): Promise<MediaStream> {
    const constraintProfiles: MediaStreamConstraints[] = [
        {
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1080 },
                height: { ideal: 1920 },
                aspectRatio: { ideal: 9 / 16 },
                frameRate: { ideal: 30, min: 15 },
            },
            audio: false,
        },
        {
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 720 },
                height: { ideal: 1280 },
                aspectRatio: { ideal: 9 / 16 },
                frameRate: { ideal: 30 },
            },
            audio: false,
        },
        {
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                aspectRatio: { ideal: 16 / 9 },
            },
            audio: false,
        },
        {
            video: {
                facingMode: { ideal: 'environment' },
                aspectRatio: { ideal: 9 / 16 },
            },
            audio: false,
        },
        {
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
        },
        { video: true, audio: false },
    ];

    let stream: MediaStream | null = null;
    let lastError: unknown = null;

    for (const constraints of constraintProfiles) {
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (stream && stream.getVideoTracks().length > 0) break;
        } catch (err) {
            lastError = err;
        }
    }

    if (!stream) throw lastError || new Error('Failed to acquire camera stream');

    const track = stream.getVideoTracks()[0];
    if (track) {
        try {
            const capabilities = (typeof track.getCapabilities === 'function'
                ? track.getCapabilities()
                : {}) as ExtendedMediaTrackCapabilities;
            const currentSettings = track.getSettings();

            if (capabilities.height && capabilities.width) {
                const maxHeight = typeof capabilities.height === 'object' && 'max' in capabilities.height ? capabilities.height.max : undefined;
                const maxWidth = typeof capabilities.width === 'object' && 'max' in capabilities.width ? capabilities.width.max : undefined;

                const currentDim = Math.max(currentSettings.width || 0, currentSettings.height || 0);
                const maxSupportedDim = Math.max(maxWidth || 0, maxHeight || 0);

                if (maxSupportedDim > currentDim && maxSupportedDim >= 1280) {
                    const targetLong = Math.min(maxSupportedDim, 1920);
                    const targetShort = Math.round(targetLong * (9 / 16));
                    const isPortraitTrack = (currentSettings.height || 0) >= (currentSettings.width || 0);

                    try {
                        await track.applyConstraints({
                            width: { ideal: isPortraitTrack ? targetShort : targetLong },
                            height: { ideal: isPortraitTrack ? targetLong : targetShort },
                            aspectRatio: { ideal: isPortraitTrack ? 9 / 16 : 16 / 9 },
                        });
                    } catch (refineErr) {
                        console.warn('applyConstraints resolution refinement skipped:', refineErr);
                    }
                }
            }

            const advancedConstraints: ExtendedMediaTrackConstraintSet = {};
            let hasAdvanced = false;

            if (capabilities.focusMode && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
                advancedConstraints.focusMode = 'continuous';
                hasAdvanced = true;
            }
            if (capabilities.exposureMode && Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
                advancedConstraints.exposureMode = 'continuous';
                hasAdvanced = true;
            }
            if (capabilities.torch === true || 'torch' in capabilities) {
                advancedConstraints.torch = true;
                hasAdvanced = true;
            }
            if (capabilities && 'zoom' in capabilities) {
                try {
                    const capZoom = (capabilities as any).zoom;
                    const minZoom = typeof capZoom === 'object' && capZoom && 'min' in capZoom
                        ? capZoom.min
                        : 1;
                    advancedConstraints.zoom = Math.max(1, minZoom || 1);
                    hasAdvanced = true;
                } catch { }
            }

            if (hasAdvanced) {
                try {
                    await track.applyConstraints({
                        advanced: [advancedConstraints as MediaTrackConstraintSet],
                    });
                } catch { }
            }
        } catch (capErr) {
            console.warn('Capability inspection/refinement encountered non-fatal error:', capErr);
        }
    }

    return stream;
}

// ─── LIVE CAMERA SCANNER & CONTINUOUS 15 FPS DETECTION COMPONENT ─────────────
const CameraCaptureAndroid: React.FC<CameraCaptureProps> = ({
    onClose,
    onCaptureFrames,
    onFrameDetected,
    onFrameDetectionError,
}) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const trackRef = useRef<MediaStreamTrack | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [isCameraReady, setIsCameraReady] = useState(false);
    const [liveFrameCount, setLiveFrameCount] = useState(0);
    const [liveDetectedCount, setLiveDetectedCount] = useState(0);
    const [latestDetection, setLatestDetection] = useState<DetectApiResponse | null>(null);
    const [flashSupported, setFlashSupported] = useState(false);
    const [isFlashOn, setIsFlashOn] = useState(false);
    const [cameraMetrics, setCameraMetrics] = useState<CameraMetrics>({});
    const [viewportHeight, setViewportHeight] = useState<number | null>(null);

    const captureTimerRef = useRef<number | null>(null);
    const framesCollectorRef = useRef<CapturedFrame[]>([]);

    const toggleFlash = async () => {
        const track = trackRef.current || streamRef.current?.getVideoTracks()[0];
        if (!track || !flashSupported) return;

        try {
            const nextState = !isFlashOn;
            const adv: ExtendedMediaTrackConstraintSet = { torch: nextState };
            await track.applyConstraints({
                advanced: [adv as MediaTrackConstraintSet],
            });
            setIsFlashOn(nextState);
        } catch (err) {
            console.error('Failed to toggle flash/torch:', err);
        }
    };

    const extractCameraDiagnostics = useCallback((stream: MediaStream) => {
        const track = stream.getVideoTracks()[0];
        if (!track) return;

        trackRef.current = track;
        const settings = track.getSettings();
        const capabilities = (typeof track.getCapabilities === 'function'
            ? track.getCapabilities()
            : {}) as ExtendedMediaTrackCapabilities;

        const actualWidth = settings.width || videoRef.current?.videoWidth;
        const actualHeight = settings.height || videoRef.current?.videoHeight;
        const actualFrameRate = settings.frameRate ? Math.round(settings.frameRate) : undefined;
        const actualAspectRatio = settings.aspectRatio || (actualWidth && actualHeight ? actualWidth / actualHeight : undefined);

        const metrics: CameraMetrics = {
            width: actualWidth,
            height: actualHeight,
            frameRate: actualFrameRate,
            aspectRatio: actualAspectRatio,
            facingMode: settings.facingMode,
            displayAspect: formatAspectRatio(actualWidth, actualHeight, actualAspectRatio),
        };

        setCameraMetrics(metrics);
        setFlashSupported(capabilities.torch === true || 'torch' in capabilities);
    }, []);

    useEffect(() => {
        const updateViewportHeight = () => {
            const h = window.visualViewport?.height ?? window.innerHeight;
            setViewportHeight(h);
        };

        updateViewportHeight();

        window.visualViewport?.addEventListener('resize', updateViewportHeight);
        window.addEventListener('resize', updateViewportHeight);
        window.addEventListener('orientationchange', updateViewportHeight);

        return () => {
            window.visualViewport?.removeEventListener('resize', updateViewportHeight);
            window.removeEventListener('resize', updateViewportHeight);
            window.removeEventListener('orientationchange', updateViewportHeight);
        };
    }, []);

    // Initialize Camera Stream
    useEffect(() => {
        let cancelled = false;

        const startCamera = async () => {
            try {
                const stream = await acquireAdaptiveCameraStreamAndroid();

                if (cancelled) {
                    stream.getTracks().forEach(track => track.stop());
                    return;
                }

                streamRef.current = stream;
                const track = stream.getVideoTracks()[0];
                trackRef.current = track;

                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    videoRef.current.onloadedmetadata = async () => {
                        if (cancelled) return;
                        try {
                            await videoRef.current?.play();
                        } catch { }
                        extractCameraDiagnostics(stream);
                        setIsCameraReady(true);
                    };
                }
            } catch (err) {
                console.error('Camera initialization failed:', err);
                if (!cancelled) {
                    alert('Unable to access camera. Please verify camera permissions.');
                }
            }
        };

        startCamera();

        return () => {
            cancelled = true;
            if (captureTimerRef.current) {
                clearInterval(captureTimerRef.current);
                captureTimerRef.current = null;
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
            if (videoRef.current) {
                videoRef.current.srcObject = null;
            }
        };
    }, [extractCameraDiagnostics]);

    // Helper: sample frame from video element
    const grabFrame = (video: HTMLVideoElement): { dataUrl: string; width: number; height: number } => {
        const width = video.videoWidth || 1080;
        const height = video.videoHeight || 1920;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
            ctx.drawImage(video, 0, 0, width, height);
            return {
                dataUrl: canvas.toDataURL('image/jpeg', 0.82),
                width,
                height,
            };
        }
        return { dataUrl: '', width, height };
    };

    // ─── AUTO-START CAPTURE WITH REAL-TIME API DETECTION FOR EACH FRAME ───
    useEffect(() => {
        if (!isCameraReady || !videoRef.current) return;

        framesCollectorRef.current = [];
        const startTime = performance.now();
        let frameNum = 0;

        // Function to invoke API detection immediately for each captured frame
        const triggerFrameApiDetection = (frame: CapturedFrame) => {
            frame.isDetecting = true;
            detectAreaDefects(frame.dataUrl)
                .then((result) => {
                    frame.detection = result;
                    frame.isDetecting = false;
                    frame.detectionError = null;
                    setLiveDetectedCount(c => c + 1);
                    setLatestDetection(result);
                    onFrameDetected?.(frame.id, result);
                })
                .catch((err) => {
                    const msg = err?.message || 'Detection failed';
                    frame.detectionError = msg;
                    frame.isDetecting = false;
                    onFrameDetectionError?.(frame.id, msg);
                });
        };

        // Sample initial first frame immediately
        const first = grabFrame(videoRef.current);
        frameNum = 1;
        const firstFrame: CapturedFrame = {
            id: `frame_${Date.now()}_1`,
            dataUrl: first.dataUrl,
            frameIndex: 1,
            timestamp: 0,
            timeString: '+0ms',
            width: first.width,
            height: first.height,
            isDetecting: true,
        };
        framesCollectorRef.current.push(firstFrame);
        setLiveFrameCount(1);
        triggerFrameApiDetection(firstFrame);

        // Capture continuous frames at 2 FPS (500ms intervals) & run API detection
        const intervalMs = Math.round(1000 / 2);
        const timer = window.setInterval(() => {
            if (!videoRef.current) return;

            frameNum++;
            const now = performance.now();
            const elapsed = Math.round(now - startTime);
            const captured = grabFrame(videoRef.current);

            const newFrame: CapturedFrame = {
                id: `frame_${Date.now()}_${frameNum}`,
                dataUrl: captured.dataUrl,
                frameIndex: frameNum,
                timestamp: elapsed,
                timeString: `+${elapsed}ms`,
                width: captured.width,
                height: captured.height,
                isDetecting: true,
            };

            framesCollectorRef.current.push(newFrame);
            setLiveFrameCount(frameNum);

            // Call Defect Detection API immediately for this newly captured frame
            triggerFrameApiDetection(newFrame);
        }, intervalMs);

        captureTimerRef.current = timer;

        return () => {
            clearInterval(timer);
            captureTimerRef.current = null;
        };
    }, [isCameraReady, onFrameDetected, onFrameDetectionError]);

    // ─── END DETECTION: FINISH CAPTURE & RETURN ALL FRAMES TO LANDING SCREEN ─
    const handleEndDetection = () => {
        if (captureTimerRef.current) {
            clearInterval(captureTimerRef.current);
            captureTimerRef.current = null;
        }

        if ('vibrate' in navigator) {
            try { navigator.vibrate([40, 50, 40]); } catch { }
        }

        // Return all captured 15 FPS frames to the landing screen
        onCaptureFrames([...framesCollectorRef.current]);
    };

    const handleCancel = () => {
        if (captureTimerRef.current) {
            clearInterval(captureTimerRef.current);
            captureTimerRef.current = null;
        }
        if (framesCollectorRef.current.length > 0) {
            onCaptureFrames([...framesCollectorRef.current]);
        } else {
            onClose();
        }
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: '#f8fafc', zIndex: 50, display: 'flex',
            flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start',
            overflow: 'hidden', height: viewportHeight ? `${viewportHeight}px` : '100dvh', width: '100vw',
        }}>
            {/* ══ TOP BAR ══ */}
            <div style={{ background: '#ffffff', borderBottom: '1px solid #e2e8f0', zIndex: 20 }}>
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 16px', paddingTop: 'calc(10px + env(safe-area-inset-top, 0px))',
                }}>
                    <button
                        onClick={handleCancel}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '6px 12px', borderRadius: 10,
                            background: '#f1f5f9', border: '1px solid #e2e8f0',
                            color: '#1e293b', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        <span>✕</span> Back
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: '#ef4444',
                            boxShadow: '0 0 8px rgba(239,68,68,0.9)',
                            animation: 'blink 1s ease-in-out infinite',
                        }} />
                        <span style={{ color: '#0f172a', fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }}>
                            Live Detection Active
                        </span>
                    </div>

                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '5px 12px', borderRadius: 20,
                        background: '#ecfdf5', border: '1px solid #a7f3d0',
                    }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
                        <span style={{ color: '#047857', fontSize: 11, fontWeight: 700, fontFamily: 'monospace' }}>
                            AI: {liveDetectedCount}/{liveFrameCount}
                        </span>
                    </div>
                </div>
            </div>

            {/* ══ PORTRAIT VIEWFINDER (CLEAN VIDEO FEED WITH LIVE AI OVERLAY) ══ */}
            <div ref={containerRef} style={{
                position: 'relative', width: '100%', flex: 1,
                overflow: 'hidden', background: '#f1f5f9',
            }}>
                {/* Floating Live Status Pill */}
                {isCameraReady && (
                    <div style={{
                        position: 'absolute', top: 14, left: 14, zIndex: 25,
                        display: 'flex', alignItems: 'center', gap: 7,
                        background: 'rgba(255, 255, 255, 0.92)', backdropFilter: 'blur(8px)',
                        padding: '6px 12px', borderRadius: 20, border: '1px solid #e2e8f0',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                    }}>
                        <div style={{
                            width: 7, height: 7, borderRadius: '50%', background: '#ef4444',
                            boxShadow: '0 0 6px #ef4444', animation: 'blink 1s ease-in-out infinite',
                        }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>
                            2 FPS • {liveFrameCount} FRAMES
                        </span>
                    </div>
                )}

                {flashSupported && isCameraReady && (
                    <button
                        onClick={toggleFlash}
                        type="button"
                        title={isFlashOn ? "Turn Flash OFF" : "Turn Flash ON"}
                        style={{
                            position: 'absolute', top: 14, right: 14, zIndex: 25,
                            display: 'flex', alignItems: 'center', gap: 6,
                            background: isFlashOn ? 'rgba(254, 240, 138, 0.95)' : 'rgba(255, 255, 255, 0.9)',
                            backdropFilter: 'blur(8px)',
                            padding: '6px 12px', borderRadius: 20,
                            border: isFlashOn ? '1px solid #eab308' : '1px solid rgba(0,0,0,0.1)',
                            color: isFlashOn ? '#854d0e' : '#1e293b',
                            cursor: 'pointer',
                            boxShadow: isFlashOn ? '0 0 14px rgba(234, 179, 8, 0.35)' : '0 2px 8px rgba(0,0,0,0.08)',
                            transition: 'all 0.2s ease',
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={isFlashOn ? '#eab308' : 'none'} stroke={isFlashOn ? '#eab308' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', fontFamily: 'monospace' }}>
                            {isFlashOn ? 'FLASH ON' : 'FLASH OFF'}
                        </span>
                    </button>
                )}

                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                        }}
                    />

                    {/* Live AI Detection Overlay on camera view */}
                    {latestDetection && (
                        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10 }}>
                            <FrameDetectionOverlay
                                detection={latestDetection}
                                showPolygons={true}
                                showBboxes={true}
                                showLabels={true}
                            />
                        </div>
                    )}
                </div>

                {/* ═══ LIVE SCREEN: DETECTED ZONES KEY DISPLAY ═══ */}
                <div style={{
                    position: 'absolute',
                    bottom: 12,
                    left: 12,
                    right: 12,
                    zIndex: 25,
                    background: 'rgba(255, 255, 255, 0.96)',
                    backdropFilter: 'blur(12px)',
                    padding: '12px 16px',
                    borderRadius: 16,
                    border: '1.5px solid #cbd5e1',
                    boxShadow: '0 10px 28px rgba(0,0,0,0.18)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{
                                width: 9, height: 9, borderRadius: '50%',
                                background: latestDetection?.detected_zones && latestDetection.detected_zones.length > 0 ? '#10b981' : '#f59e0b',
                                boxShadow: latestDetection?.detected_zones && latestDetection.detected_zones.length > 0 ? '0 0 8px #10b981' : 'none',
                            }} />
                            <span style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', letterSpacing: '0.02em' }}>
                                DETECTED ZONES ({latestDetection?.detected_zones?.length || 0})
                            </span>
                        </div>
                        {latestDetection?.inference_time_ms ? (
                            <span style={{ fontSize: 12, color: '#475569', fontFamily: 'monospace', fontWeight: 700 }}>
                                ⚡ {latestDetection.inference_time_ms.toFixed(0)}ms
                            </span>
                        ) : (
                            <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
                                In Real-Time
                            </span>
                        )}
                    </div>

                    {/* Detected zones chips list (Enlarged & Prominent) */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {latestDetection?.detected_zones && latestDetection.detected_zones.length > 0 ? (
                            latestDetection.detected_zones.map((zoneKey) => {
                                const theme = getZoneTheme(zoneKey);
                                const zoneData = latestDetection.zones?.[zoneKey];
                                const confStr = zoneData?.confidence ? ` ${(zoneData.confidence * 100).toFixed(0)}%` : '';
                                return (
                                    <div
                                        key={zoneKey}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 7,
                                            padding: '6px 14px',
                                            borderRadius: 10,
                                            background: theme.badgeBg,
                                            border: `1.5px solid ${theme.border}`,
                                            color: theme.badgeText,
                                            fontSize: 14,
                                            fontWeight: 800,
                                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                                        }}
                                    >
                                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: theme.stroke, boxShadow: `0 0 5px ${theme.stroke}99` }} />
                                        <span>{zoneKey}{confStr}</span>
                                    </div>
                                );
                            })
                        ) : (
                            <span style={{ fontSize: 13, color: '#64748b', fontStyle: 'italic', padding: '2px 0' }}>
                                Scanning frame for detected_zones (tread_shoulder, bead, sidewall)...
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* ══ BOTTOM CONTROLS ("END DETECTION" BUTTON) ══ */}
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 10, padding: '14px 16px',
                paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
                background: '#ffffff', borderTop: '1px solid #e2e8f0',
                boxShadow: '0 -2px 10px rgba(0,0,0,0.02)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 440 }}>
                    {/* Live Metrics */}
                    <div style={{
                        display: 'flex', flexDirection: 'column', gap: 2, padding: '5px 10px',
                        borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0',
                        minWidth: 80,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
                            <span style={{ color: '#0f172a', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
                                {cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'LIVE'}
                            </span>
                        </div>
                        <div style={{ color: '#64748b', fontSize: 10, fontFamily: 'monospace' }}>
                            2 FPS
                        </div>
                    </div>

                    {/* ══ "END DETECTION" BUTTON ══ */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <button
                            onClick={handleEndDetection}
                            disabled={!isCameraReady}
                            title="End Detection & View All Frames"
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                padding: '12px 24px', borderRadius: 14,
                                background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                color: '#ffffff', border: 'none',
                                cursor: !isCameraReady ? 'not-allowed' : 'pointer',
                                opacity: !isCameraReady ? 0.6 : 1,
                                boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)',
                                transition: 'all 0.15s ease',
                            }}
                        >
                            <div style={{ width: 12, height: 12, background: '#ffffff', borderRadius: 2 }} />
                            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.02em' }}>
                                End Detection
                            </span>
                        </button>
                        <span style={{ color: '#64748b', fontSize: 10, fontWeight: 600 }}>
                            {liveFrameCount} frames • {liveDetectedCount} AI analyzed
                        </span>
                    </div>

                    <div style={{ minWidth: 80, display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ color: '#94a3b8', fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', fontWeight: 600 }}>
                            {cameraMetrics.facingMode || 'REAR'}
                        </span>
                    </div>
                </div>
            </div>

            <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
      `}</style>
        </div>
    );
};

export const CameraCaptureIOS: React.FC<CameraCaptureProps> = CameraCaptureAndroid;

// ═════════════════════════════════════════════════════════════════════════════
// ─── MASTER COMPONENT: RESPONSIVE LANDING SCREEN WITH CAPTURED FRAMES ─────────
// ═════════════════════════════════════════════════════════════════════════════
const Home: React.FC = () => {
    const [activeScreen, setActiveScreen] = useState<'dashboard' | 'scanner'>('dashboard');
    const [capturedFrames, setCapturedFrames] = useState<CapturedFrame[]>([]);

    // Modal viewers
    const [selectedFrame, setSelectedFrame] = useState<CapturedFrame | null>(null);
    const [fullScreenImageFrame, setFullScreenImageFrame] = useState<CapturedFrame | null>(null);
    const [isPlayingSequence, setIsPlayingSequence] = useState(false);
    const [playbackIndex, setPlaybackIndex] = useState(0);
    const [isAutoPlaying, setIsAutoPlaying] = useState(false);

    // AI Defect Detection states
    const [showPolygons, setShowPolygons] = useState(true);
    const [showBboxes, setShowBboxes] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [isBatchDetecting, setIsBatchDetecting] = useState(false);
    const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

    // Extract all unique detected_zones found across all frames
    const uniqueDetectedZones = useMemo(() => {
        const set = new Set<string>();
        capturedFrames.forEach(f => {
            f.detection?.detected_zones?.forEach(z => set.add(z));
        });
        return Array.from(set);
    }, [capturedFrames]);

    // Flipbook player timer for 2 FPS playback
    useEffect(() => {
        let timer: number | null = null;
        if (isPlayingSequence && isAutoPlaying && capturedFrames.length > 0) {
            const frameDelay = Math.round(1000 / 2);
            timer = window.setInterval(() => {
                setPlaybackIndex(prev => (prev + 1) % capturedFrames.length);
            }, frameDelay);
        }
        return () => {
            if (timer) clearInterval(timer);
        };
    }, [isPlayingSequence, isAutoPlaying, capturedFrames.length]);

    // Handle incoming frames from scanner after End Detection
    const handleCapturedFrames = (frames: CapturedFrame[]) => {
        setCapturedFrames(frames);
        setActiveScreen('dashboard');
        setPlaybackIndex(0);
    };

    // ─── DEFECT DETECTION API INTEGRATION HANDLERS ────────────────────────────
    const handleDetectFrame = async (frame: CapturedFrame) => {
        // Mark as detecting
        setCapturedFrames(prev =>
            prev.map(f => (f.id === frame.id ? { ...f, isDetecting: true, detectionError: null } : f))
        );
        setSelectedFrame(prev =>
            prev && prev.id === frame.id ? { ...prev, isDetecting: true, detectionError: null } : prev
        );

        try {
            const result = await detectAreaDefects(frame.dataUrl);
            setCapturedFrames(prev =>
                prev.map(f =>
                    f.id === frame.id
                        ? { ...f, isDetecting: false, detection: result, detectionError: null }
                        : f
                )
            );
            setSelectedFrame(prev =>
                prev && prev.id === frame.id
                    ? { ...prev, isDetecting: false, detection: result, detectionError: null }
                    : prev
            );
        } catch (err: any) {
            const errorMsg = err?.message || 'Failed to detect defect zones. Please check network.';
            setCapturedFrames(prev =>
                prev.map(f =>
                    f.id === frame.id
                        ? { ...f, isDetecting: false, detectionError: errorMsg }
                        : f
                )
            );
            setSelectedFrame(prev =>
                prev && prev.id === frame.id
                    ? { ...prev, isDetecting: false, detectionError: errorMsg }
                    : prev
            );
        }
    };

    const handleDetectAllFrames = async () => {
        if (capturedFrames.length === 0 || isBatchDetecting) return;
        setIsBatchDetecting(true);

        const pending = capturedFrames.filter(f => !f.detection);
        const toProcess = pending.length > 0 ? pending : capturedFrames;
        setBatchProgress({ current: 0, total: toProcess.length });

        for (let i = 0; i < toProcess.length; i++) {
            setBatchProgress({ current: i + 1, total: toProcess.length });
            await handleDetectFrame(toProcess[i]);
        }

        setIsBatchDetecting(false);
    };

    // Download single frame as JPEG
    const downloadFrame = (frame: CapturedFrame) => {
        const link = document.createElement('a');
        link.href = frame.dataUrl;
        link.download = `defect_frame_${frame.frameIndex}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // Download all frames
    const downloadAllFrames = () => {
        capturedFrames.forEach((frame, idx) => {
            setTimeout(() => {
                downloadFrame(frame);
            }, idx * 100);
        });
    };

    // Live frame detection handler from camera stream
    const handleLiveFrameDetected = useCallback((frameId: string, detection: DetectApiResponse) => {
        setCapturedFrames(prev =>
            prev.map(f => (f.id === frameId ? { ...f, detection, isDetecting: false, detectionError: null } : f))
        );
        setSelectedFrame(prev =>
            prev && prev.id === frameId ? { ...prev, detection, isDetecting: false, detectionError: null } : prev
        );
    }, []);

    const handleLiveFrameDetectionError = useCallback((frameId: string, error: string) => {
        setCapturedFrames(prev =>
            prev.map(f => (f.id === frameId ? { ...f, isDetecting: false, detectionError: error } : f))
        );
        setSelectedFrame(prev =>
            prev && prev.id === frameId ? { ...prev, isDetecting: false, detectionError: error } : prev
        );
    }, []);

    return (
        <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: "'DM Sans', sans-serif", color: '#0f172a', position: 'relative' }}>
            {/* ═══ SCREEN 2: LIVE CAMERA SCANNER ═══ */}
            {activeScreen === 'scanner' && (
                <CameraCaptureAndroid
                    onClose={() => setActiveScreen('dashboard')}
                    onCaptureFrames={handleCapturedFrames}
                    onFrameDetected={handleLiveFrameDetected}
                    onFrameDetectionError={handleLiveFrameDetectionError}
                />
            )}

            {/* ═══ SCREEN 1: LANDING SCREEN ═══ */}
            {activeScreen === 'dashboard' && (
                <div className="landing-container">
                    {/* Header bar */}
                    <header className="responsive-header">
                        <div className="header-brand-row">
                            <div className="brand-icon-box">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="22" y1="12" x2="18" y2="12" />
                                    <line x1="6" y1="12" x2="2" y2="12" />
                                    <line x1="12" y1="6" x2="12" y2="2" />
                                    <line x1="12" y1="22" x2="12" y2="18" />
                                </svg>
                            </div>
                            <div className="brand-text-box">
                                <div className="brand-title-line">
                                    <h1 className="brand-title">Live Defect Detection</h1>
                                    <span className="ai-ready-badge">AI READY</span>
                                </div>
                                <p className="brand-subtitle">
                                    Continuous 2 FPS live scanning with frame gallery
                                </p>
                            </div>
                        </div>

                        {/* Top quick metrics chips */}
                        <div className="header-chips-row">
                            <div className="status-chip">
                                <span className="chip-label">Scan Rate</span>
                                <span className="chip-value">2 FPS Live</span>
                            </div>
                            {capturedFrames.length > 0 && (
                                <div className="status-chip highlight">
                                    <span className="chip-label">Captured</span>
                                    <span className="chip-value green">{capturedFrames.length} Frames</span>
                                </div>
                            )}
                        </div>
                    </header>

                    {/* ══ HERO CARD: "CLICK HERE TO DETECT DEFECT" ══ */}
                    <div className="responsive-hero-card">
                        <div className="hero-content">
                            <div className="hero-badge-row">
                                <span className="hero-status-pill">
                                    <span className="pulse-dot" />
                                    Live Auto-Scanner
                                </span>
                                <span className="hero-rate-tag">2 FPS Continuous</span>
                            </div>
                            <h2 className="hero-heading">
                                Start Live Scanning & Defect Capture
                            </h2>
                            <p className="hero-desc">
                                Opens the camera screen, automatically records 2 frames/sec continuously, and saves all frames when you press <strong>End Detection</strong>.
                            </p>
                        </div>

                        {/* Primary Button */}
                        <div className="hero-btn-container">
                            <button
                                onClick={() => setActiveScreen('scanner')}
                                className="hero-detect-btn"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                                    <circle cx="12" cy="13" r="4" />
                                </svg>
                                <span>Click here to detect defect</span>
                            </button>
                        </div>
                    </div>

                    {/* ═══ CAPTURED FRAMES SECTION ON LANDING SCREEN ═══ */}
                    {capturedFrames.length > 0 ? (
                        <div className="frames-section">
                            {/* Toolbar */}
                            <div className="frames-toolbar">
                                <div className="toolbar-title-box">
                                    <h3 className="toolbar-title">Captured Frames</h3>
                                    <span className="toolbar-count-badge">
                                        {capturedFrames.length} Frames @ 2 FPS
                                    </span>
                                </div>

                                <div className="toolbar-actions">
                                    {/* AI Detect All Button */}
                                    <button
                                        onClick={handleDetectAllFrames}
                                        disabled={isBatchDetecting}
                                        className="toolbar-btn ai-detect"
                                        title="Send all captured frames to the AI Defect Detection API"
                                    >
                                        {isBatchDetecting ? (
                                            <>
                                                <div className="btn-spinner" />
                                                <span>Analyzing {batchProgress.current}/{batchProgress.total}</span>
                                            </>
                                        ) : (
                                            <>
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                                                </svg>
                                                <span>AI Detect All</span>
                                            </>
                                        )}
                                    </button>

                                    <button
                                        onClick={() => {
                                            setPlaybackIndex(0);
                                            setIsAutoPlaying(true);
                                            setIsPlayingSequence(true);
                                        }}
                                        className="toolbar-btn primary"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="#10b981" stroke="#10b981" strokeWidth="2">
                                            <polygon points="5 3 19 12 5 21 5 3" />
                                        </svg>
                                        <span>Play 2 FPS</span>
                                    </button>

                                    <button
                                        onClick={downloadAllFrames}
                                        className="toolbar-btn secondary"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                            <polyline points="7 10 12 15 17 10" />
                                            <line x1="12" y1="15" x2="12" y2="3" />
                                        </svg>
                                        <span>Download All</span>
                                    </button>

                                    <button
                                        onClick={() => setCapturedFrames([])}
                                        className="toolbar-btn danger"
                                    >
                                        Clear
                                    </button>
                                </div>
                            </div>

                            {/* ═══ OVERALL DETECTED ZONES SUMMARY BANNER ═══ */}
                            {uniqueDetectedZones.length > 0 && (
                                <div className="overall-zones-banner">
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }} />
                                        <span style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', letterSpacing: '0.02em' }}>
                                            DETECTED ZONES IN CAPTURE ({uniqueDetectedZones.length}):
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        {uniqueDetectedZones.map(zone => {
                                            const theme = getZoneTheme(zone);
                                            return (
                                                <span
                                                    key={zone}
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        padding: '5px 12px',
                                                        borderRadius: 8,
                                                        background: theme.badgeBg,
                                                        border: `1.5px solid ${theme.border}`,
                                                        color: theme.badgeText,
                                                        fontSize: 13,
                                                        fontWeight: 800,
                                                        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                                                    }}
                                                >
                                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.stroke, boxShadow: `0 0 4px ${theme.stroke}99` }} />
                                                    {zone}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Responsive Frames Grid */}
                            <div className="responsive-frames-grid">
                                {capturedFrames.map((frame) => {
                                    const detectedZones = frame.detection?.detected_zones || [];
                                    return (
                                        <div
                                            key={frame.id}
                                            onClick={() => setSelectedFrame(frame)}
                                            className="frame-card"
                                        >
                                            <div className="frame-thumb-wrapper">
                                                <img
                                                    src={frame.dataUrl}
                                                    alt={`Frame ${frame.frameIndex}`}
                                                    className="frame-image"
                                                />
                                                {/* Frame badge */}
                                                <span className="frame-index-badge">
                                                    #{frame.frameIndex}
                                                </span>

                                                {/* Timestamp badge */}
                                                <span className="frame-time-badge">
                                                    {frame.timeString}
                                                </span>

                                                {/* Detection Status Overlay Badge */}
                                                {frame.isDetecting && (
                                                    <div className="frame-card-badge detecting">
                                                        <span className="pulse-mini" />
                                                        <span>Analyzing...</span>
                                                    </div>
                                                )}
                                                {frame.detection && (
                                                    <div className="frame-card-badge success">
                                                        ✓ {detectedZones.length} Zones
                                                    </div>
                                                )}
                                                {frame.detectionError && (
                                                    <div className="frame-card-badge error">
                                                        ✕ Error
                                                    </div>
                                                )}
                                            </div>

                                            <div className="frame-info-bar">
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
                                                    <span className="frame-info-num">
                                                        Frame #{frame.frameIndex}
                                                    </span>
                                                    <span className="frame-info-dim">
                                                        {frame.width}×{frame.height}
                                                    </span>
                                                </div>

                                                {!frame.detection && !frame.isDetecting && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDetectFrame(frame);
                                                        }}
                                                        className="frame-quick-detect-btn"
                                                        title="Run AI Defect Detection"
                                                    >
                                                        ⚡ Detect
                                                    </button>
                                                )}
                                            </div>

                                            {/* ═══ DETECTED ZONES KEY DISPLAY ON EACH FRAME CARD ═══ */}
                                            <div className="frame-card-zones-section">
                                                {detectedZones.length > 0 ? (
                                                    <div className="frame-card-zones-list">
                                                        {detectedZones.map((zone) => {
                                                            const theme = getZoneTheme(zone);
                                                            const zoneData = frame.detection?.zones?.[zone];
                                                            const conf = zoneData?.confidence ? ` ${(zoneData.confidence * 100).toFixed(0)}%` : '';
                                                            return (
                                                                <span
                                                                    key={zone}
                                                                    className="frame-zone-tag"
                                                                    style={{
                                                                        background: theme.badgeBg,
                                                                        borderColor: theme.border,
                                                                        color: theme.badgeText,
                                                                    }}
                                                                >
                                                                    <span className="zone-dot" style={{ background: theme.stroke }} />
                                                                    {zone}{conf}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                ) : frame.isDetecting ? (
                                                    <span className="frame-zone-status detecting">
                                                        Detecting zones...
                                                    </span>
                                                ) : frame.detection ? (
                                                    <span className="frame-zone-status empty">
                                                        No zones detected
                                                    </span>
                                                ) : (
                                                    <span className="frame-zone-status pending">
                                                        Zones pending
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        /* Empty State */
                        <div className="empty-state-card">
                            <div className="empty-icon-circle">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                    <polyline points="21 15 16 10 5 21" />
                                </svg>
                            </div>
                            <h3 className="empty-title">
                                No Frames Captured Yet
                            </h3>
                            <p className="empty-desc">
                                Click <strong>"Click here to detect defect"</strong> above. The camera will automatically start capturing at 2 FPS, and pressing <strong>End Detection</strong> will display all frames here.
                            </p>
                            <button
                                onClick={() => setActiveScreen('scanner')}
                                className="empty-launch-btn"
                            >
                                Launch Live Detection
                            </button>
                        </div>
                    )}

                    {/* ═══ MODAL 1: SINGLE FRAME INSPECTOR WITH DEFECT DETECTION ═══ */}
                    {selectedFrame && (
                        <div
                            onClick={() => setSelectedFrame(null)}
                            className="modal-backdrop"
                        >
                            <div
                                onClick={(e) => e.stopPropagation()}
                                className="modal-dialog inspect"
                            >
                                <div className="modal-header">
                                    <div>
                                        <h4 className="modal-title">
                                            Frame #{selectedFrame.frameIndex} Inspection
                                        </h4>
                                        <span className="modal-subtitle">
                                            {selectedFrame.timeString} • {selectedFrame.width}×{selectedFrame.height}px
                                            {selectedFrame.detection?.route && ` • Route: ${selectedFrame.detection.route}`}
                                        </span>
                                    </div>
                                    <div className="modal-header-actions">
                                        <button
                                            onClick={() => handleDetectFrame(selectedFrame)}
                                            disabled={selectedFrame.isDetecting}
                                            className="modal-action-btn"
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 5,
                                                background: selectedFrame.detection ? '#ecfdf5' : '#10b981',
                                                color: selectedFrame.detection ? '#047857' : '#ffffff',
                                                border: selectedFrame.detection ? '1px solid #a7f3d0' : 'none',
                                                fontWeight: 700,
                                            }}
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                                            </svg>
                                            <span>
                                                {selectedFrame.isDetecting
                                                    ? 'Analyzing...'
                                                    : selectedFrame.detection
                                                    ? 'Re-Detect'
                                                    : 'Detect AI'}
                                            </span>
                                        </button>
                                        <button
                                            onClick={() => downloadFrame(selectedFrame)}
                                            className="modal-action-btn"
                                        >
                                            Download
                                        </button>
                                        <button
                                            onClick={() => setSelectedFrame(null)}
                                            className="modal-close-btn"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>

                                <div className="modal-inspect-body">
                                    {/* Image Viewport with SVG overlay (Clickable to open in separate dialog) */}
                                    <div
                                        className="modal-image-viewport"
                                        onClick={() => setFullScreenImageFrame(selectedFrame)}
                                        title="Click to view image in full-size dialog"
                                    >
                                        <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0, maxWidth: '100%' }}>
                                            <img
                                                src={selectedFrame.dataUrl}
                                                alt={`Frame ${selectedFrame.frameIndex}`}
                                                className="modal-full-img"
                                            />
                                            {selectedFrame.isDetecting && <ScanningOverlay />}
                                            {selectedFrame.detection && (
                                                <FrameDetectionOverlay
                                                    detection={selectedFrame.detection}
                                                    showPolygons={showPolygons}
                                                    showBboxes={showBboxes}
                                                    showLabels={showLabels}
                                                />
                                            )}
                                        </div>
                                        <div className="image-expand-hint">
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <polyline points="15 3 21 3 21 9" />
                                                <polyline points="9 21 3 21 3 15" />
                                                <line x1="21" y1="3" x2="14" y2="10" />
                                                <line x1="3" y1="21" x2="10" y2="14" />
                                            </svg>
                                            <span>Click to view full image</span>
                                        </div>
                                    </div>

                                    {/* Defect Detection Controls & Details */}
                                    <div style={{ padding: '6px 16px 20px' }}>
                                        <DetectionControlsPanel
                                            detection={selectedFrame.detection}
                                            isDetecting={selectedFrame.isDetecting}
                                            detectionError={selectedFrame.detectionError}
                                            showPolygons={showPolygons}
                                            showBboxes={showBboxes}
                                            showLabels={showLabels}
                                            onTogglePolygons={() => setShowPolygons(p => !p)}
                                            onToggleBboxes={() => setShowBboxes(b => !b)}
                                            onToggleLabels={() => setShowLabels(l => !l)}
                                            onDetect={() => handleDetectFrame(selectedFrame)}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ═══ MODAL: SEPARATE FULL-SIZE IMAGE DIALOG ═══ */}
                    {fullScreenImageFrame && (
                        <div
                            onClick={() => setFullScreenImageFrame(null)}
                            className="modal-backdrop full-image-backdrop"
                        >
                            <div
                                onClick={(e) => e.stopPropagation()}
                                className="modal-dialog full-image-dialog"
                            >
                                <div className="modal-header full-image-header">
                                    <div>
                                        <h4 className="modal-title full-image-title">
                                            Frame #{fullScreenImageFrame.frameIndex} • Full Image View
                                        </h4>
                                        <span className="modal-subtitle">
                                            {fullScreenImageFrame.width}×{fullScreenImageFrame.height}px
                                            {fullScreenImageFrame.detection?.route && ` • Route: ${fullScreenImageFrame.detection.route}`}
                                            {fullScreenImageFrame.detection?.detected_zones && ` • (${fullScreenImageFrame.detection.detected_zones.length} Zones)`}
                                        </span>
                                    </div>
                                    <div className="modal-header-actions">
                                        <label className="full-toggle-lbl">
                                            <input
                                                type="checkbox"
                                                checked={showPolygons}
                                                onChange={() => setShowPolygons(p => !p)}
                                                style={{ accentColor: '#10b981', cursor: 'pointer', width: 14, height: 14 }}
                                            />
                                            Polygons
                                        </label>
                                        <label className="full-toggle-lbl">
                                            <input
                                                type="checkbox"
                                                checked={showBboxes}
                                                onChange={() => setShowBboxes(b => !b)}
                                                style={{ accentColor: '#10b981', cursor: 'pointer', width: 14, height: 14 }}
                                            />
                                            Boxes
                                        </label>
                                        <label className="full-toggle-lbl">
                                            <input
                                                type="checkbox"
                                                checked={showLabels}
                                                onChange={() => setShowLabels(l => !l)}
                                                style={{ accentColor: '#10b981', cursor: 'pointer', width: 14, height: 14 }}
                                            />
                                            Labels
                                        </label>
                                        <button
                                            onClick={() => downloadFrame(fullScreenImageFrame)}
                                            className="modal-action-btn"
                                        >
                                            Download
                                        </button>
                                        <button
                                            onClick={() => setFullScreenImageFrame(null)}
                                            className="modal-close-btn"
                                            aria-label="Close full view"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>

                                <div className="full-image-viewport">
                                    <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0, maxWidth: '100%', maxHeight: '100%' }}>
                                        <img
                                            src={fullScreenImageFrame.dataUrl}
                                            alt={`Frame ${fullScreenImageFrame.frameIndex} full view`}
                                            className="full-image-elem"
                                        />
                                        {fullScreenImageFrame.detection && (
                                            <FrameDetectionOverlay
                                                detection={fullScreenImageFrame.detection}
                                                showPolygons={showPolygons}
                                                showBboxes={showBboxes}
                                                showLabels={showLabels}
                                            />
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ═══ MODAL 2: 15 FPS FLIPBOOK SEQUENCE PLAYER ═══ */}
                    {isPlayingSequence && capturedFrames.length > 0 && (
                        <div
                            onClick={() => setIsPlayingSequence(false)}
                            className="modal-backdrop"
                        >
                            <div
                                onClick={(e) => e.stopPropagation()}
                                className="modal-dialog player"
                            >
                                <div className="modal-header">
                                    <div>
                                        <h4 className="modal-title">
                                            Sequence Playback (2 FPS)
                                        </h4>
                                        <span className="modal-subtitle highlight">
                                            Frame {playbackIndex + 1} of {capturedFrames.length} ({capturedFrames[playbackIndex]?.timeString})
                                        </span>
                                    </div>
                                    <button
                                        onClick={() => setIsPlayingSequence(false)}
                                        className="modal-close-btn"
                                    >
                                        ✕
                                    </button>
                                </div>

                                <div className="modal-player-viewport">
                                    <img
                                        src={capturedFrames[playbackIndex]?.dataUrl}
                                        alt={`Frame ${playbackIndex + 1}`}
                                        className="player-active-img"
                                    />
                                    <div className="player-floating-tag">
                                        FRAME #{playbackIndex + 1} • {capturedFrames[playbackIndex]?.timeString}
                                    </div>
                                </div>

                                {/* Playback Controls */}
                                <div className="player-controls-box">
                                    <input
                                        type="range"
                                        min="0"
                                        max={capturedFrames.length - 1}
                                        value={playbackIndex}
                                        onChange={(e) => {
                                            setIsAutoPlaying(false);
                                            setPlaybackIndex(Number(e.target.value));
                                        }}
                                        className="player-timeline-slider"
                                    />

                                    <div className="player-buttons-row">
                                        <button
                                            onClick={() => {
                                                setIsAutoPlaying(false);
                                                setPlaybackIndex(prev => (prev - 1 + capturedFrames.length) % capturedFrames.length);
                                            }}
                                            className="player-btn prev"
                                        >
                                            ◀ Prev
                                        </button>

                                        <button
                                            onClick={() => setIsAutoPlaying(prev => !prev)}
                                            className="player-btn play"
                                        >
                                            {isAutoPlaying ? '❚❚ Pause' : '▶ Play'}
                                        </button>

                                        <button
                                            onClick={() => {
                                                setIsAutoPlaying(false);
                                                setPlaybackIndex(prev => (prev + 1) % capturedFrames.length);
                                            }}
                                            className="player-btn next"
                                        >
                                            Next ▶
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ═══ RESPONSIVE CSS STYLES FOR ALL SCREEN SIZES ═══ */}
            <style>{`
        /* Mobile-First Layout Styles */
        .landing-container {
            width: 100%;
            max-width: 1100px;
            margin: 0 auto;
            padding: 16px 14px 60px;
            box-sizing: border-box;
        }

        /* Responsive Header */
        .responsive-header {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding-bottom: 16px;
            border-bottom: 1px solid #e2e8f0;
            margin-bottom: 20px;
        }

        .header-brand-row {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
        }

        .brand-icon-box {
            width: 38px;
            height: 38px;
            min-width: 38px;
            border-radius: 10px;
            background: linear-gradient(135deg, #10b981, #059669);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #ffffff;
            box-shadow: 0 3px 10px rgba(16, 185, 129, 0.28);
        }

        .brand-text-box {
            flex: 1;
            min-width: 0;
        }

        .brand-title-line {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .brand-title {
            font-size: 18px;
            font-weight: 800;
            color: #0f172a;
            margin: 0;
            letter-spacing: -0.02em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .ai-ready-badge {
            font-size: 10px;
            font-weight: 700;
            padding: 2px 7px;
            border-radius: 10px;
            background: #ecfdf5;
            color: #047857;
            border: 1px solid #a7f3d0;
            letter-spacing: 0.04em;
        }

        .brand-subtitle {
            font-size: 12px;
            color: #64748b;
            margin: 2px 0 0;
            line-height: 1.3;
        }

        .header-chips-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .status-chip {
            padding: 6px 12px;
            border-radius: 8px;
            background: #ffffff;
            border: 1px solid #e2e8f0;
            box-shadow: 0 1px 2px rgba(0,0,0,0.03);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .chip-label {
            font-size: 11px;
            color: #64748b;
        }

        .chip-value {
            font-size: 12px;
            font-weight: 700;
            color: #0f172a;
        }

        .chip-value.green {
            color: #047857;
        }

        /* Responsive Hero Card */
        .responsive-hero-card {
            background: linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%);
            border: 1.5px solid #a7f3d0;
            border-radius: 16px;
            padding: 18px 16px;
            margin-bottom: 24px;
            box-shadow: 0 8px 20px -4px rgba(16, 185, 129, 0.08);
            display: flex;
            flex-direction: column;
            gap: 16px;
            box-sizing: border-box;
        }

        .hero-badge-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            margin-bottom: 8px;
        }

        .hero-status-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            font-weight: 700;
            color: #047857;
            background: #d1fae5;
            padding: 3px 9px;
            border-radius: 16px;
        }

        .pulse-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #10b981;
            display: inline-block;
        }

        .hero-rate-tag {
            font-size: 11px;
            color: #64748b;
            font-weight: 600;
        }

        .hero-heading {
            font-size: 18px;
            font-weight: 800;
            color: #0f172a;
            margin: 0 0 6px;
            letter-spacing: -0.01em;
            line-height: 1.3;
        }

        .hero-desc {
            font-size: 13px;
            color: #475569;
            line-height: 1.45;
            margin: 0;
        }

        .hero-btn-container {
            width: 100%;
        }

        .hero-detect-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            width: 100%;
            padding: 14px 20px;
            border-radius: 12px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
            font-size: 15px;
            font-weight: 700;
            border: none;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(16, 185, 129, 0.35);
            transition: all 0.2s ease;
            box-sizing: border-box;
        }

        .hero-detect-btn:active {
            transform: scale(0.98);
        }

        /* Responsive Frames Grid */
        .frames-section {
            width: 100%;
        }

        .frames-toolbar {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 14px;
        }

        .toolbar-title-box {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .toolbar-title {
            font-size: 16px;
            font-weight: 700;
            color: #0f172a;
            margin: 0;
        }

        .toolbar-count-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 16px;
            background: #ecfdf5;
            color: #047857;
            border: 1px solid #a7f3d0;
        }

        .toolbar-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            width: 100%;
        }

        .toolbar-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 7px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .toolbar-btn.primary {
            background: #ffffff;
            border: 1px solid #cbd5e1;
            color: #0f172a;
            box-shadow: 0 1px 2px rgba(0,0,0,0.04);
            flex: 1;
            justify-content: center;
        }

        .toolbar-btn.secondary {
            background: #ffffff;
            border: 1px solid #cbd5e1;
            color: #0f172a;
            box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }

        .toolbar-btn.danger {
            background: #fef2f2;
            border: 1px solid #fecaca;
            color: #dc2626;
        }

        /* AI Detect Toolbar Button */
        .toolbar-btn.ai-detect {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
            border: none;
            box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
        }

        .toolbar-btn.ai-detect:disabled {
            opacity: 0.75;
            cursor: wait;
        }

        .btn-spinner {
            width: 12px;
            height: 12px;
            border: 2px solid #ffffff;
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        /* 2 Columns on Mobile, scalable on desktop */
        .responsive-frames-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            width: 100%;
        }

        .frame-card {
            background: #ffffff;
            border-radius: 12px;
            border: 1px solid #e2e8f0;
            overflow: hidden;
            box-shadow: 0 1px 4px rgba(0,0,0,0.04);
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
        }

        .frame-thumb-wrapper {
            position: relative;
            width: 100%;
            aspect-ratio: 9 / 13;
            background: #0f172a;
        }

        .frame-image {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }

        .frame-index-badge {
            position: absolute;
            top: 6px;
            left: 6px;
            background: rgba(15, 23, 42, 0.85);
            color: #ffffff;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 700;
            font-family: monospace;
            backdrop-filter: blur(4px);
            z-index: 4;
        }

        .frame-time-badge {
            position: absolute;
            bottom: 6px;
            right: 6px;
            background: rgba(16, 185, 129, 0.92);
            color: #ffffff;
            padding: 2px 5px;
            border-radius: 4px;
            font-size: 9px;
            font-weight: 700;
            font-family: monospace;
            z-index: 4;
        }

        /* Frame Card Detection Badges */
        .frame-card-badge {
            position: absolute;
            bottom: 6px;
            left: 6px;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 9px;
            font-weight: 700;
            backdrop-filter: blur(4px);
            display: flex;
            align-items: center;
            gap: 4px;
            z-index: 5;
        }

        .frame-card-badge.detecting {
            background: rgba(245, 158, 11, 0.95);
            color: #ffffff;
        }

        .frame-card-badge.success {
            background: rgba(16, 185, 129, 0.95);
            color: #ffffff;
        }

        .frame-card-badge.error {
            background: rgba(239, 68, 68, 0.95);
            color: #ffffff;
        }

        .pulse-mini {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: #ffffff;
            animation: blink 1s infinite;
        }

        .frame-quick-detect-btn {
            padding: 3px 7px;
            border-radius: 6px;
            background: #ecfdf5;
            color: #047857;
            border: 1px solid #a7f3d0;
            font-size: 10px;
            font-weight: 700;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s ease;
        }

        .frame-quick-detect-btn:hover {
            background: #d1fae5;
            border-color: #6ee7b7;
        }

        .frame-info-bar {
            padding: 8px 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .frame-info-num {
            font-size: 11px;
            font-weight: 600;
            color: #0f172a;
        }

        .frame-info-dim {
            font-size: 10px;
            color: #64748b;
        }

        /* Overall Detected Zones Banner */
        .overall-zones-banner {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            background: #ffffff;
            border: 1.5px solid #a7f3d0;
            border-radius: 12px;
            padding: 10px 14px;
            margin-bottom: 14px;
            box-shadow: 0 2px 8px rgba(16, 185, 129, 0.08);
        }

        /* Frame Card Zones Section */
        .frame-card-zones-section {
            padding: 0 10px 8px;
            min-height: 24px;
            display: flex;
            align-items: center;
        }

        .frame-card-zones-list {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            width: 100%;
        }

        .frame-zone-tag {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 8px;
            border-radius: 6px;
            border: 1px solid transparent;
            font-size: 11.5px;
            font-weight: 800;
            letter-spacing: 0.01em;
        }

        .zone-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            display: inline-block;
        }

        .frame-zone-status {
            font-size: 11px;
            font-weight: 600;
        }

        .frame-zone-status.detecting {
            color: #d97706;
        }

        .frame-zone-status.empty {
            color: #94a3b8;
            font-style: italic;
        }

        .frame-zone-status.pending {
            color: #94a3b8;
        }

        /* Empty State */
        .empty-state-card {
            text-align: center;
            padding: 32px 16px;
            background: #ffffff;
            border-radius: 16px;
            border: 1.5px dashed #cbd5e1;
        }

        .empty-icon-circle {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: #f1f5f9;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 12px;
            color: #64748b;
        }

        .empty-title {
            font-size: 15px;
            font-weight: 700;
            color: #0f172a;
            margin: 0 0 4px;
        }

        .empty-desc {
            font-size: 12px;
            color: #64748b;
            max-width: 380px;
            margin: 0 auto 16px;
            line-height: 1.4;
        }

        .empty-launch-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 10px 18px;
            border-radius: 10px;
            background: #10b981;
            color: white;
            border: none;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
        }

        /* Modals */
        .modal-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(6px);
            z-index: 100;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px;
            box-sizing: border-box;
        }

        .modal-dialog {
            background: #ffffff;
            border-radius: 16px;
            width: 100%;
            max-width: 580px;
            max-height: 90dvh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 0 20px 40px -10px rgba(0,0,0,0.3);
        }

        .modal-dialog.inspect {
            max-width: 660px;
            max-height: 90dvh;
        }

        .modal-inspect-body {
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            overscroll-behavior: contain;
        }

        .modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid #e2e8f0;
        }

        .modal-title {
            margin: 0;
            font-size: 14px;
            font-weight: 700;
            color: #0f172a;
        }

        .modal-subtitle {
            font-size: 11px;
            color: #64748b;
        }

        .modal-subtitle.highlight {
            color: #047857;
            font-weight: 600;
        }

        .modal-header-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .modal-action-btn {
            padding: 5px 10px;
            border-radius: 6px;
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            color: #0f172a;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
        }

        .modal-close-btn {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            color: #64748b;
            font-size: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-image-viewport {
            background: #020617;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 8px 12px;
            max-height: 30vh;
            overflow: hidden;
            position: relative;
            cursor: pointer;
            border-bottom: 1px solid #e2e8f0;
            user-select: none;
        }

        .modal-full-img {
            max-width: 100%;
            max-height: 28vh;
            height: auto;
            object-fit: contain;
            border-radius: 8px;
            display: block;
            margin: 0 auto;
            box-shadow: 0 4px 14px rgba(0,0,0,0.4);
            transition: transform 0.2s ease;
        }

        .modal-image-viewport:hover .modal-full-img {
            transform: scale(1.015);
        }

        .image-expand-hint {
            position: absolute;
            bottom: 8px;
            right: 10px;
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(6px);
            color: #ffffff;
            font-size: 11px;
            font-weight: 700;
            padding: 4px 10px;
            border-radius: 20px;
            display: flex;
            align-items: center;
            gap: 5px;
            pointer-events: none;
            border: 1px solid rgba(255, 255, 255, 0.25);
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }

        /* Full-Size Separate Image Dialog */
        .modal-backdrop.full-image-backdrop {
            z-index: 150;
            background: rgba(2, 6, 23, 0.94);
            padding: 10px;
        }

        .modal-dialog.full-image-dialog {
            max-width: 95vw;
            max-height: 95dvh;
            background: #0b1120;
            border: 1px solid #1e293b;
            display: flex;
            flex-direction: column;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6);
        }

        .full-image-header {
            background: #0f172a;
            border-bottom: 1px solid #1e293b;
            padding: 10px 16px;
        }

        .full-image-title {
            color: #f8fafc;
        }

        .full-toggle-lbl {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 12px;
            font-weight: 600;
            color: #cbd5e1;
            cursor: pointer;
        }

        .full-image-viewport {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto;
            padding: 12px;
            background: #020617;
            min-height: 250px;
        }

        .full-image-elem {
            max-width: 92vw;
            max-height: 82dvh;
            width: auto;
            height: auto;
            object-fit: contain;
            border-radius: 8px;
            display: block;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }

        .modal-player-viewport {
            background: #0f172a;
            width: 100%;
            aspect-ratio: 9 / 13;
            max-height: 50vh;
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .player-active-img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .player-floating-tag {
            position: absolute;
            bottom: 10px;
            left: 10px;
            background: rgba(0,0,0,0.75);
            color: white;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
        }

        .player-controls-box {
            padding: 14px 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .player-timeline-slider {
            width: 100%;
            accent-color: #10b981;
            cursor: pointer;
        }

        .player-buttons-row {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        .player-btn {
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
        }

        .player-btn.prev, .player-btn.next {
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            color: #0f172a;
        }

        .player-btn.play {
            background: #10b981;
            color: #ffffff;
            border: none;
            padding: 7px 18px;
            font-weight: 700;
            box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
        }

        /* ═══ TABLET & DESKTOP BREAKPOINTS ═══ */
        @media (min-width: 641px) {
            .landing-container {
                padding: 24px 20px 60px;
            }

            .responsive-header {
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                padding-bottom: 20px;
                margin-bottom: 28px;
            }

            .brand-icon-box {
                width: 44px;
                height: 44px;
                min-width: 44px;
                border-radius: 12px;
            }

            .brand-title {
                font-size: 22px;
            }

            .brand-subtitle {
                font-size: 13px;
            }

            .responsive-hero-card {
                padding: 28px 24px;
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                gap: 20px;
            }

            .hero-content {
                max-width: 540px;
            }

            .hero-heading {
                font-size: 22px;
            }

            .hero-btn-container {
                width: auto;
                min-width: 240px;
            }

            .hero-detect-btn {
                width: auto;
                padding: 16px 28px;
                font-size: 16px;
            }

            .frames-toolbar {
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 18px;
            }

            .toolbar-actions {
                width: auto;
            }

            .responsive-frames-grid {
                grid-template-columns: repeat(3, 1fr);
                gap: 14px;
            }
        }

        @media (min-width: 900px) {
            .responsive-frames-grid {
                grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
                gap: 16px;
            }
        }
      `}</style>
        </div>
    );
};

export default Home;
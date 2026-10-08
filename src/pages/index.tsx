import React, { useState, useRef, useEffect, useCallback } from 'react';

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
    timestamp: number; // ms from start
    timeString: string;
    width: number;
    height: number;
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
    targetFps?: number;
    frameCount?: number;
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

// ─── LIVE CAMERA SCANNER & 10-15 FPS FRAME CAPTURE COMPONENT ─────────────────
const CameraCaptureAndroid: React.FC<CameraCaptureProps> = ({
    onClose,
    onCaptureFrames,
    targetFps = 15,
    frameCount = 15,
}) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const trackRef = useRef<MediaStreamTrack | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [isCameraReady, setIsCameraReady] = useState(false);
    const [isCapturing, setIsCapturing] = useState(false);
    const [capturedCount, setCapturedCount] = useState(0);
    const [currentFps, setCurrentFps] = useState<number>(targetFps);
    const [totalFrames, setTotalFrames] = useState<number>(frameCount);
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

    // Capture individual frame from video element to JPEG dataURL
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
                dataUrl: canvas.toDataURL('image/jpeg', 0.88),
                width,
                height,
            };
        }
        return { dataUrl: '', width, height };
    };

    // Trigger high-speed 10-15 FPS frame capture sequence
    const triggerFrameCapture = () => {
        if (!videoRef.current || !isCameraReady || isCapturing) return;

        setIsCapturing(true);
        setCapturedCount(0);
        framesCollectorRef.current = [];

        if ('vibrate' in navigator) {
            try { navigator.vibrate(60); } catch { }
        }

        const intervalMs = Math.round(1000 / currentFps); // ~66ms for 15 FPS, 100ms for 10 FPS
        const startTime = performance.now();
        let frameIndex = 0;

        // Grab first frame immediately
        const first = grabFrame(videoRef.current);
        frameIndex = 1;
        framesCollectorRef.current.push({
            id: `frame_${Date.now()}_1`,
            dataUrl: first.dataUrl,
            frameIndex: 1,
            timestamp: 0,
            timeString: '+0ms',
            width: first.width,
            height: first.height,
        });
        setCapturedCount(1);

        captureTimerRef.current = window.setInterval(() => {
            if (!videoRef.current) {
                if (captureTimerRef.current) clearInterval(captureTimerRef.current);
                return;
            }

            frameIndex++;
            const now = performance.now();
            const elapsed = Math.round(now - startTime);
            const captured = grabFrame(videoRef.current);

            framesCollectorRef.current.push({
                id: `frame_${Date.now()}_${frameIndex}`,
                dataUrl: captured.dataUrl,
                frameIndex,
                timestamp: elapsed,
                timeString: `+${elapsed}ms`,
                width: captured.width,
                height: captured.height,
            });

            setCapturedCount(frameIndex);

            if (frameIndex >= totalFrames) {
                if (captureTimerRef.current) {
                    clearInterval(captureTimerRef.current);
                    captureTimerRef.current = null;
                }

                if ('vibrate' in navigator) {
                    try { navigator.vibrate([40, 60, 40]); } catch { }
                }

                setIsCapturing(false);

                // Seamlessly return back to first screen with all captured frames
                onCaptureFrames([...framesCollectorRef.current]);
            }
        }, intervalMs);
    };

    const captureProgress = Math.min(Math.round((capturedCount / totalFrames) * 100), 100);

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: '#f8fafc', zIndex: 50, display: 'flex',
            flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start',
            overflow: 'hidden', height: viewportHeight ? `${viewportHeight}px` : '100dvh', width: '100vw',
        }}>
            {/* ══ TOP BAR (LIGHT THEME) ══ */}
            <div style={{ background: '#ffffff', borderBottom: '1px solid #e2e8f0', zIndex: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))' }}>
                    <button
                        onClick={onClose}
                        disabled={isCapturing}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '8px 14px', borderRadius: 12,
                            background: '#f1f5f9', border: '1px solid #e2e8f0',
                            color: isCapturing ? '#94a3b8' : '#1e293b',
                            fontSize: 13, fontWeight: 600, cursor: isCapturing ? 'not-allowed' : 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        <span>←</span> Back
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: isCapturing ? '#ef4444' : '#10b981',
                            boxShadow: isCapturing ? '0 0 8px rgba(239,68,68,0.8)' : '0 0 8px rgba(16,185,129,0.8)',
                            animation: isCapturing ? 'pulse 0.4s ease infinite alternate' : 'blink 1.5s ease-in-out infinite',
                        }} />
                        <span style={{ color: '#0f172a', fontSize: 13, fontWeight: 700, letterSpacing: '0.05em' }}>
                            {isCapturing ? 'CAPTURING FRAMES' : 'Live Detection'}
                        </span>
                    </div>

                    <div style={{
                        padding: '6px 12px', borderRadius: 20,
                        background: '#f1f5f9', border: '1px solid #e2e8f0',
                    }}>
                        <span style={{ color: '#047857', fontSize: 11, fontWeight: 700, fontFamily: 'monospace' }}>
                            {currentFps} FPS
                        </span>
                    </div>
                </div>
            </div>

            {/* ══ PORTRAIT VIEWFINDER (CLEAN VIDEO, NO OVERLAY LINES/INSTRUCTIONS) ══ */}
            <div ref={containerRef} style={{
                position: 'relative', width: '100%', flex: 1,
                overflow: 'hidden', background: '#f1f5f9',
            }}>
                {flashSupported && isCameraReady && (
                    <button
                        onClick={toggleFlash}
                        type="button"
                        title={isFlashOn ? "Turn Flash OFF" : "Turn Flash ON"}
                        style={{
                            position: 'absolute', top: 16, right: 16, zIndex: 25,
                            display: 'flex', alignItems: 'center', gap: 8,
                            background: isFlashOn ? 'rgba(254, 240, 138, 0.95)' : 'rgba(255, 255, 255, 0.9)',
                            backdropFilter: 'blur(8px)',
                            padding: '8px 14px', borderRadius: 20,
                            border: isFlashOn ? '1px solid #eab308' : '1px solid rgba(0,0,0,0.1)',
                            color: isFlashOn ? '#854d0e' : '#1e293b',
                            cursor: 'pointer',
                            boxShadow: isFlashOn ? '0 0 14px rgba(234, 179, 8, 0.35)' : '0 2px 8px rgba(0,0,0,0.08)',
                            transition: 'all 0.2s ease',
                        }}
                    >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill={isFlashOn ? '#eab308' : 'none'} stroke={isFlashOn ? '#eab308' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', fontFamily: 'monospace' }}>
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
                </div>

                {/* Shutter flash animation while capturing */}
                {isCapturing && (
                    <div style={{
                        position: 'absolute', inset: 0,
                        background: 'rgba(255, 255, 255, 0.3)',
                        pointerEvents: 'none',
                        animation: 'shutterFlash 0.15s ease-out infinite alternate',
                    }} />
                )}
            </div>

            {/* ══ BOTTOM CONTROLS (CAPTURE FRAME TRIGGER & SETTINGS) ══ */}
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 12, padding: '16px 20px 20px',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
                background: '#ffffff', borderTop: '1px solid #e2e8f0',
                boxShadow: '0 -2px 10px rgba(0,0,0,0.02)',
            }}>
                {/* Real-time Capture Progress Bar */}
                {isCapturing && (
                    <div style={{ width: '100%', maxWidth: 280, textAlign: 'center' }}>
                        <div style={{ width: '100%', height: 6, borderRadius: 3, background: '#e2e8f0', overflow: 'hidden', marginBottom: 6 }}>
                            <div style={{
                                height: '100%', borderRadius: 3,
                                background: 'linear-gradient(90deg, #10b981, #059669)',
                                width: `${captureProgress}%`,
                                transition: 'width 0.08s linear',
                            }} />
                        </div>
                        <span style={{ color: '#0f172a', fontSize: 12, fontWeight: 700 }}>
                            Capturing Frame {capturedCount} of {totalFrames} ({currentFps} FPS)...
                        </span>
                    </div>
                )}

                {/* Rate & Frame Count Selectors */}
                {!isCapturing && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', background: '#f1f5f9', padding: 3, borderRadius: 10, border: '1px solid #e2e8f0' }}>
                            <button
                                onClick={() => setCurrentFps(10)}
                                style={{
                                    padding: '4px 10px', borderRadius: 8, border: 'none',
                                    background: currentFps === 10 ? '#ffffff' : 'transparent',
                                    color: currentFps === 10 ? '#0f172a' : '#64748b',
                                    fontWeight: currentFps === 10 ? 700 : 500, fontSize: 11, cursor: 'pointer',
                                    boxShadow: currentFps === 10 ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                                }}
                            >
                                10 FPS
                            </button>
                            <button
                                onClick={() => setCurrentFps(15)}
                                style={{
                                    padding: '4px 10px', borderRadius: 8, border: 'none',
                                    background: currentFps === 15 ? '#ffffff' : 'transparent',
                                    color: currentFps === 15 ? '#0f172a' : '#64748b',
                                    fontWeight: currentFps === 15 ? 700 : 500, fontSize: 11, cursor: 'pointer',
                                    boxShadow: currentFps === 15 ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                                }}
                            >
                                15 FPS
                            </button>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', background: '#f1f5f9', padding: 3, borderRadius: 10, border: '1px solid #e2e8f0' }}>
                            <button
                                onClick={() => setTotalFrames(10)}
                                style={{
                                    padding: '4px 10px', borderRadius: 8, border: 'none',
                                    background: totalFrames === 10 ? '#ffffff' : 'transparent',
                                    color: totalFrames === 10 ? '#0f172a' : '#64748b',
                                    fontWeight: totalFrames === 10 ? 700 : 500, fontSize: 11, cursor: 'pointer',
                                    boxShadow: totalFrames === 10 ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                                }}
                            >
                                10 Frames
                            </button>
                            <button
                                onClick={() => setTotalFrames(15)}
                                style={{
                                    padding: '4px 10px', borderRadius: 8, border: 'none',
                                    background: totalFrames === 15 ? '#ffffff' : 'transparent',
                                    color: totalFrames === 15 ? '#0f172a' : '#64748b',
                                    fontWeight: totalFrames === 15 ? 700 : 500, fontSize: 11, cursor: 'pointer',
                                    boxShadow: totalFrames === 15 ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                                }}
                            >
                                15 Frames
                            </button>
                        </div>
                    </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 480 }}>
                    {/* Resolution & FPS metrics */}
                    <div style={{
                        display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 12px',
                        borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0',
                        minWidth: 100,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
                            <span style={{ color: '#0f172a', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
                                {cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'LIVE'}
                            </span>
                        </div>
                        <div style={{ color: '#64748b', fontSize: 10, fontFamily: 'monospace' }}>
                            {cameraMetrics.frameRate ? `${cameraMetrics.frameRate} FPS` : 'Adaptive'}
                        </div>
                    </div>

                    {/* Prominent "CAPTURE FRAME" Button */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <button
                            onClick={triggerFrameCapture}
                            disabled={!isCameraReady || isCapturing}
                            title="Capture Frame"
                            style={{
                                position: 'relative', background: 'none', border: 'none', padding: 0,
                                cursor: (!isCameraReady || isCapturing) ? 'not-allowed' : 'pointer',
                                opacity: (!isCameraReady || isCapturing) ? 0.6 : 1,
                                transform: isCapturing ? 'scale(0.96)' : 'scale(1)',
                                transition: 'all 0.15s ease',
                            }}
                        >
                            <div style={{
                                width: 72, height: 72, borderRadius: '50%',
                                border: '3px solid #10b981',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: isCapturing ? '#fef2f2' : '#f0fdf4',
                                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.25)',
                            }}>
                                <div style={{
                                    width: 52, height: 52, borderRadius: '50%',
                                    background: isCapturing
                                        ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                                        : 'linear-gradient(135deg, #10b981, #059669)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: 'white',
                                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                                }}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                                        <circle cx="12" cy="13" r="4" />
                                    </svg>
                                </div>
                            </div>
                        </button>
                        <span style={{ color: isCapturing ? '#dc2626' : '#0f172a', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
                            {isCapturing ? `CAPTURING (${capturedCount}/${totalFrames})` : 'CAPTURE FRAME'}
                        </span>
                        <span style={{ color: '#64748b', fontSize: 10, marginTop: -3 }}>
                            {currentFps} FPS Burst ({totalFrames} Frames)
                        </span>
                    </div>

                    <div style={{ minWidth: 100, display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ color: '#94a3b8', fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', fontWeight: 600 }}>
                            {cameraMetrics.facingMode || 'REAR'}
                        </span>
                    </div>
                </div>
            </div>

            <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes pulse { from{transform:scale(0.85);opacity:0.7} to{transform:scale(1.2);opacity:1} }
        @keyframes shutterFlash { from{opacity:0.1} to{opacity:0.45} }
      `}</style>
        </div>
    );
};

export const CameraCaptureIOS: React.FC<CameraCaptureProps> = CameraCaptureAndroid;

// ═════════════════════════════════════════════════════════════════════════════
// ─── MASTER COMPONENT: LIVE DEFECT DETECTION MODEL & DASHBOARD ───────────────
// ═════════════════════════════════════════════════════════════════════════════
const Home: React.FC = () => {
    const [activeScreen, setActiveScreen] = useState<'dashboard' | 'scanner'>('dashboard');
    const [capturedFrames, setCapturedFrames] = useState<CapturedFrame[]>([]);
    const [targetFps, setTargetFps] = useState<number>(15);
    const [frameCount, setFrameCount] = useState<number>(15);

    // Modal viewers
    const [selectedFrame, setSelectedFrame] = useState<CapturedFrame | null>(null);
    const [isPlayingSequence, setIsPlayingSequence] = useState(false);
    const [playbackIndex, setPlaybackIndex] = useState(0);
    const [isAutoPlaying, setIsAutoPlaying] = useState(false);

    // Flipbook player timer
    useEffect(() => {
        let timer: number | null = null;
        if (isPlayingSequence && isAutoPlaying && capturedFrames.length > 0) {
            const frameDelay = Math.round(1000 / targetFps);
            timer = window.setInterval(() => {
                setPlaybackIndex(prev => (prev + 1) % capturedFrames.length);
            }, frameDelay);
        }
        return () => {
            if (timer) clearInterval(timer);
        };
    }, [isPlayingSequence, isAutoPlaying, capturedFrames.length, targetFps]);

    // Handle incoming frames from scanner
    const handleCapturedFrames = (frames: CapturedFrame[]) => {
        setCapturedFrames(frames);
        setActiveScreen('dashboard');
        setPlaybackIndex(0);
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
            }, idx * 120);
        });
    };

    return (
        <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: "'DM Sans', sans-serif", color: '#0f172a', position: 'relative' }}>
            {/* ═══ SCREEN 2: LIVE CAMERA SCANNER ═══ */}
            {activeScreen === 'scanner' && (
                <CameraCaptureAndroid
                    onClose={() => setActiveScreen('dashboard')}
                    onCaptureFrames={handleCapturedFrames}
                    targetFps={targetFps}
                    frameCount={frameCount}
                />
            )}

            {/* ═══ SCREEN 1: LIVE DEFECT DETECTION MODEL DASHBOARD ═══ */}
            {activeScreen === 'dashboard' && (
                <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 60px' }}>
                    {/* Header bar */}
                    <header style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        flexWrap: 'wrap', gap: 16, paddingBottom: 20, borderBottom: '1px solid #e2e8f0', marginBottom: 28,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{
                                width: 44, height: 44, borderRadius: 12,
                                background: 'linear-gradient(135deg, #10b981, #059669)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: 'white', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
                            }}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="22" y1="12" x2="18" y2="12" />
                                    <line x1="6" y1="12" x2="2" y2="12" />
                                    <line x1="12" y1="6" x2="12" y2="2" />
                                    <line x1="12" y1="22" x2="12" y2="18" />
                                </svg>
                            </div>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#0f172a', letterSpacing: '-0.02em' }}>
                                        Live Defect Detection Model
                                    </h1>
                                    <span style={{
                                        fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 12,
                                        background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0',
                                    }}>
                                        AI ENGINE READY
                                    </span>
                                </div>
                                <p style={{ fontSize: 13, color: '#64748b', margin: '3px 0 0' }}>
                                    High-speed multi-frame optical inspection system (10–15 FPS)
                                </p>
                            </div>
                        </div>

                        {/* Top quick stats / info */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                                padding: '8px 14px', borderRadius: 10, background: '#ffffff',
                                border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                            }}>
                                <span style={{ fontSize: 11, color: '#64748b', display: 'block' }}>Capture Rate</span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{targetFps} Frames/Sec</span>
                            </div>
                            <div style={{
                                padding: '8px 14px', borderRadius: 10, background: '#ffffff',
                                border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                            }}>
                                <span style={{ fontSize: 11, color: '#64748b', display: 'block' }}>Burst Size</span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{frameCount} Frames</span>
                            </div>
                        </div>
                    </header>

                    {/* ══ HERO ACTION CARD: "CLICK HERE TO DETECT DEFECT" ══ */}
                    <div style={{
                        background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
                        border: '1.5px solid #a7f3d0',
                        borderRadius: 20,
                        padding: '28px 24px',
                        marginBottom: 32,
                        boxShadow: '0 10px 25px -5px rgba(16, 185, 129, 0.1), 0 8px 10px -6px rgba(16, 185, 129, 0.05)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 20,
                    }}>
                        <div style={{ maxWidth: 540 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 6,
                                    fontSize: 12, fontWeight: 700, color: '#047857',
                                    background: '#d1fae5', padding: '4px 10px', borderRadius: 20,
                                }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                                    Live Inspection Camera
                                </span>
                                <span style={{ fontSize: 12, color: '#64748b' }}>• Instant 10–15 FPS Burst</span>
                            </div>
                            <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px', color: '#0f172a', letterSpacing: '-0.02em' }}>
                                Start Live Scanning & Defect Capture
                            </h2>
                            <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.5, margin: 0 }}>
                                Open the live camera scanner to capture high-speed sequential frames for surface defect analysis, tire tread defects, or anomaly detection.
                            </p>
                        </div>

                        {/* Primary Button */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 260 }}>
                            <button
                                onClick={() => setActiveScreen('scanner')}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                                    padding: '16px 28px', borderRadius: 14,
                                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                                    color: '#ffffff',
                                    fontSize: 16, fontWeight: 700,
                                    border: 'none', cursor: 'pointer',
                                    boxShadow: '0 6px 20px rgba(16, 185, 129, 0.35)',
                                    transition: 'all 0.2s ease',
                                }}
                            >
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                                    <circle cx="12" cy="13" r="4" />
                                </svg>
                                <span>Click here to detect defect</span>
                            </button>

                            {/* Preset controls */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                <div style={{ display: 'flex', background: '#ffffff', borderRadius: 8, padding: 2, border: '1px solid #cbd5e1' }}>
                                    <button
                                        onClick={() => setTargetFps(10)}
                                        style={{
                                            border: 'none', padding: '3px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                                            background: targetFps === 10 ? '#10b981' : 'transparent',
                                            color: targetFps === 10 ? '#ffffff' : '#475569',
                                            fontWeight: targetFps === 10 ? 700 : 500,
                                        }}
                                    >10 FPS</button>
                                    <button
                                        onClick={() => setTargetFps(15)}
                                        style={{
                                            border: 'none', padding: '3px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                                            background: targetFps === 15 ? '#10b981' : 'transparent',
                                            color: targetFps === 15 ? '#ffffff' : '#475569',
                                            fontWeight: targetFps === 15 ? 700 : 500,
                                        }}
                                    >15 FPS</button>
                                </div>
                                <div style={{ display: 'flex', background: '#ffffff', borderRadius: 8, padding: 2, border: '1px solid #cbd5e1' }}>
                                    <button
                                        onClick={() => setFrameCount(10)}
                                        style={{
                                            border: 'none', padding: '3px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                                            background: frameCount === 10 ? '#10b981' : 'transparent',
                                            color: frameCount === 10 ? '#ffffff' : '#475569',
                                            fontWeight: frameCount === 10 ? 700 : 500,
                                        }}
                                    >10 Frames</button>
                                    <button
                                        onClick={() => setFrameCount(15)}
                                        style={{
                                            border: 'none', padding: '3px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                                            background: frameCount === 15 ? '#10b981' : 'transparent',
                                            color: frameCount === 15 ? '#ffffff' : '#475569',
                                            fontWeight: frameCount === 15 ? 700 : 500,
                                        }}
                                    >15 Frames</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ═══ CAPTURED FRAMES SECTION ═══ */}
                    {capturedFrames.length > 0 ? (
                        <div>
                            {/* Gallery Toolbar */}
                            <div style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                flexWrap: 'wrap', gap: 12, marginBottom: 18,
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0f172a' }}>
                                        Captured Frames
                                    </h3>
                                    <span style={{
                                        fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                                        background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0',
                                    }}>
                                        {capturedFrames.length} Frames @ {targetFps} FPS
                                    </span>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <button
                                        onClick={() => {
                                            setPlaybackIndex(0);
                                            setIsAutoPlaying(true);
                                            setIsPlayingSequence(true);
                                        }}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 6,
                                            padding: '8px 14px', borderRadius: 10,
                                            background: '#ffffff', border: '1px solid #cbd5e1',
                                            color: '#0f172a', fontSize: 13, fontWeight: 600,
                                            cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                                        }}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="#10b981" stroke="#10b981" strokeWidth="2">
                                            <polygon points="5 3 19 12 5 21 5 3" />
                                        </svg>
                                        <span>Play 15 FPS Sequence</span>
                                    </button>

                                    <button
                                        onClick={downloadAllFrames}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 6,
                                            padding: '8px 14px', borderRadius: 10,
                                            background: '#ffffff', border: '1px solid #cbd5e1',
                                            color: '#0f172a', fontSize: 13, fontWeight: 600,
                                            cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                                        }}
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
                                        style={{
                                            padding: '8px 12px', borderRadius: 10,
                                            background: '#fef2f2', border: '1px solid #fecaca',
                                            color: '#dc2626', fontSize: 13, fontWeight: 600,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Clear
                                    </button>
                                </div>
                            </div>

                            {/* Responsive Frames Grid */}
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                                gap: 16,
                            }}>
                                {capturedFrames.map((frame) => (
                                    <div
                                        key={frame.id}
                                        onClick={() => setSelectedFrame(frame)}
                                        style={{
                                            background: '#ffffff',
                                            borderRadius: 14,
                                            border: '1px solid #e2e8f0',
                                            overflow: 'hidden',
                                            boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
                                            cursor: 'pointer',
                                            transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.transform = 'translateY(-3px)';
                                            e.currentTarget.style.boxShadow = '0 8px 18px rgba(0,0,0,0.08)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.transform = 'translateY(0)';
                                            e.currentTarget.style.boxShadow = '0 2px 6px rgba(0,0,0,0.04)';
                                        }}
                                    >
                                        <div style={{ position: 'relative', width: '100%', aspectRatio: '9 / 14', background: '#0f172a' }}>
                                            <img
                                                src={frame.dataUrl}
                                                alt={`Frame ${frame.frameIndex}`}
                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                            />
                                            {/* Frame badge */}
                                            <span style={{
                                                position: 'absolute', top: 8, left: 8,
                                                background: 'rgba(15, 23, 42, 0.8)', color: '#ffffff',
                                                padding: '3px 8px', borderRadius: 6,
                                                fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
                                                backdropFilter: 'blur(4px)',
                                            }}>
                                                #{frame.frameIndex}
                                            </span>

                                            {/* Timestamp badge */}
                                            <span style={{
                                                position: 'absolute', bottom: 8, right: 8,
                                                background: 'rgba(16, 185, 129, 0.9)', color: '#ffffff',
                                                padding: '2px 6px', borderRadius: 4,
                                                fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
                                            }}>
                                                {frame.timeString}
                                            </span>
                                        </div>

                                        <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                            <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>
                                                Frame #{frame.frameIndex}
                                            </span>
                                            <span style={{ fontSize: 11, color: '#64748b' }}>
                                                {frame.width}×{frame.height}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        /* Empty State */
                        <div style={{
                            textAlign: 'center', padding: '48px 20px',
                            background: '#ffffff', borderRadius: 16,
                            border: '1.5px dashed #cbd5e1',
                        }}>
                            <div style={{
                                width: 56, height: 56, borderRadius: '50%',
                                background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                margin: '0 auto 16px', color: '#64748b',
                            }}>
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                    <polyline points="21 15 16 10 5 21" />
                                </svg>
                            </div>
                            <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px', color: '#0f172a' }}>
                                No Frames Captured Yet
                            </h3>
                            <p style={{ fontSize: 13, color: '#64748b', maxWidth: 400, margin: '0 auto 20px' }}>
                                Tap <strong>"Click here to detect defect"</strong> above to launch the live scanner and capture 10 to 15 frames per second.
                            </p>
                            <button
                                onClick={() => setActiveScreen('scanner')}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 8,
                                    padding: '10px 20px', borderRadius: 10,
                                    background: '#10b981', color: 'white',
                                    border: 'none', fontSize: 13, fontWeight: 700,
                                    cursor: 'pointer', boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
                                }}
                            >
                                Launch Live Detection
                            </button>
                        </div>
                    )}

                    {/* ═══ MODAL 1: SINGLE FRAME INSPECTOR ═══ */}
                    {selectedFrame && (
                        <div
                            onClick={() => setSelectedFrame(null)}
                            style={{
                                position: 'fixed', inset: 0,
                                background: 'rgba(15, 23, 42, 0.75)', backdropFilter: 'blur(6px)',
                                zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                padding: 20,
                            }}
                        >
                            <div
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                    background: '#ffffff', borderRadius: 18,
                                    maxWidth: 680, width: '100%', maxHeight: '92vh',
                                    display: 'flex', flexDirection: 'column',
                                    overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
                                }}
                            >
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '14px 18px', borderBottom: '1px solid #e2e8f0',
                                }}>
                                    <div>
                                        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
                                            Frame #{selectedFrame.frameIndex} Inspection
                                        </h4>
                                        <span style={{ fontSize: 11, color: '#64748b' }}>
                                            Interval: {selectedFrame.timeString} • {selectedFrame.width}×{selectedFrame.height}px
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <button
                                            onClick={() => downloadFrame(selectedFrame)}
                                            style={{
                                                padding: '6px 12px', borderRadius: 8,
                                                background: '#f1f5f9', border: '1px solid #e2e8f0',
                                                color: '#0f172a', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                            }}
                                        >
                                            Download
                                        </button>
                                        <button
                                            onClick={() => setSelectedFrame(null)}
                                            style={{
                                                width: 32, height: 32, borderRadius: 8,
                                                background: '#f1f5f9', border: '1px solid #e2e8f0',
                                                color: '#64748b', fontSize: 16, cursor: 'pointer',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            }}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>

                                <div style={{
                                    flex: 1, overflow: 'auto', background: '#0f172a',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
                                }}>
                                    <img
                                        src={selectedFrame.dataUrl}
                                        alt={`Frame ${selectedFrame.frameIndex}`}
                                        style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 8 }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ═══ MODAL 2: 15 FPS FLIPBOOK SEQUENCE PLAYER ═══ */}
                    {isPlayingSequence && capturedFrames.length > 0 && (
                        <div
                            onClick={() => setIsPlayingSequence(false)}
                            style={{
                                position: 'fixed', inset: 0,
                                background: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(8px)',
                                zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                padding: 20,
                            }}
                        >
                            <div
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                    background: '#ffffff', borderRadius: 20,
                                    maxWidth: 600, width: '100%',
                                    overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.3)',
                                }}
                            >
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '14px 20px', borderBottom: '1px solid #e2e8f0',
                                }}>
                                    <div>
                                        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
                                            Live Sequence Playback ({targetFps} FPS)
                                        </h4>
                                        <span style={{ fontSize: 11, color: '#047857', fontWeight: 600 }}>
                                            Frame {playbackIndex + 1} of {capturedFrames.length} ({capturedFrames[playbackIndex]?.timeString})
                                        </span>
                                    </div>
                                    <button
                                        onClick={() => setIsPlayingSequence(false)}
                                        style={{
                                            width: 32, height: 32, borderRadius: 8,
                                            background: '#f1f5f9', border: '1px solid #e2e8f0',
                                            color: '#64748b', fontSize: 16, cursor: 'pointer',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        }}
                                    >
                                        ✕
                                    </button>
                                </div>

                                <div style={{
                                    background: '#0f172a', width: '100%', aspectRatio: '9 / 14', maxHeight: '55vh',
                                    position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                }}>
                                    <img
                                        src={capturedFrames[playbackIndex]?.dataUrl}
                                        alt={`Frame ${playbackIndex + 1}`}
                                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                                    />
                                    <div style={{
                                        position: 'absolute', bottom: 12, left: 12,
                                        background: 'rgba(0,0,0,0.7)', color: 'white',
                                        padding: '4px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
                                    }}>
                                        FRAME #{playbackIndex + 1} • {capturedFrames[playbackIndex]?.timeString}
                                    </div>
                                </div>

                                {/* Playback Controls */}
                                <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    {/* Scrubber slider */}
                                    <input
                                        type="range"
                                        min="0"
                                        max={capturedFrames.length - 1}
                                        value={playbackIndex}
                                        onChange={(e) => {
                                            setIsAutoPlaying(false);
                                            setPlaybackIndex(Number(e.target.value));
                                        }}
                                        style={{ width: '100%', accentColor: '#10b981', cursor: 'pointer' }}
                                    />

                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                                        <button
                                            onClick={() => {
                                                setIsAutoPlaying(false);
                                                setPlaybackIndex(prev => (prev - 1 + capturedFrames.length) % capturedFrames.length);
                                            }}
                                            style={{
                                                padding: '6px 14px', borderRadius: 8, background: '#f1f5f9',
                                                border: '1px solid #e2e8f0', color: '#0f172a', fontWeight: 600, cursor: 'pointer',
                                            }}
                                        >
                                            ◀ Prev
                                        </button>

                                        <button
                                            onClick={() => setIsAutoPlaying(prev => !prev)}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 6,
                                                padding: '8px 20px', borderRadius: 10,
                                                background: '#10b981', color: '#ffffff',
                                                border: 'none', fontWeight: 700, cursor: 'pointer',
                                                boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
                                            }}
                                        >
                                            {isAutoPlaying ? '❚❚ Pause' : '▶ Play'}
                                        </button>

                                        <button
                                            onClick={() => {
                                                setIsAutoPlaying(false);
                                                setPlaybackIndex(prev => (prev + 1) % capturedFrames.length);
                                            }}
                                            style={{
                                                padding: '6px 14px', borderRadius: 8, background: '#f1f5f9',
                                                border: '1px solid #e2e8f0', color: '#0f172a', fontWeight: 600, cursor: 'pointer',
                                            }}
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
        </div>
    );
};

export default Home;
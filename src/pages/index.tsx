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
    timestamp: number; // ms from scan start
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
}) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const trackRef = useRef<MediaStreamTrack | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [isCameraReady, setIsCameraReady] = useState(false);
    const [liveFrameCount, setLiveFrameCount] = useState(0);
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

    // ─── AUTO-START 15 FPS CONTINUOUS CAPTURE ON SCREEN OPEN ──────────────
    useEffect(() => {
        if (!isCameraReady || !videoRef.current) return;

        framesCollectorRef.current = [];
        const startTime = performance.now();
        let frameNum = 0;

        // Sample initial first frame immediately
        const first = grabFrame(videoRef.current);
        frameNum = 1;
        framesCollectorRef.current.push({
            id: `frame_${Date.now()}_1`,
            dataUrl: first.dataUrl,
            frameIndex: 1,
            timestamp: 0,
            timeString: '+0ms',
            width: first.width,
            height: first.height,
        });
        setLiveFrameCount(1);

        // Capture continuous frames at 15 FPS (~66.6ms intervals)
        const intervalMs = Math.round(1000 / 15);
        const timer = window.setInterval(() => {
            if (!videoRef.current) return;

            frameNum++;
            const now = performance.now();
            const elapsed = Math.round(now - startTime);
            const captured = grabFrame(videoRef.current);

            framesCollectorRef.current.push({
                id: `frame_${Date.now()}_${frameNum}`,
                dataUrl: captured.dataUrl,
                frameIndex: frameNum,
                timestamp: elapsed,
                timeString: `+${elapsed}ms`,
                width: captured.width,
                height: captured.height,
            });

            setLiveFrameCount(frameNum);
        }, intervalMs);

        captureTimerRef.current = timer;

        return () => {
            clearInterval(timer);
            captureTimerRef.current = null;
        };
    }, [isCameraReady]);

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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))' }}>
                    <button
                        onClick={handleCancel}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '8px 14px', borderRadius: 12,
                            background: '#f1f5f9', border: '1px solid #e2e8f0',
                            color: '#1e293b', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        <span>✕</span> Cancel
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: '#ef4444',
                            boxShadow: '0 0 8px rgba(239,68,68,0.9)',
                            animation: 'blink 1s ease-in-out infinite',
                        }} />
                        <span style={{ color: '#0f172a', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
                            Live Detection Active
                        </span>
                    </div>

                    <div style={{
                        padding: '6px 14px', borderRadius: 20,
                        background: '#ecfdf5', border: '1px solid #a7f3d0',
                    }}>
                        <span style={{ color: '#047857', fontSize: 11, fontWeight: 700, fontFamily: 'monospace' }}>
                            15 FPS
                        </span>
                    </div>
                </div>
            </div>

            {/* ══ PORTRAIT VIEWFINDER (CLEAN VIDEO FEED) ══ */}
            <div ref={containerRef} style={{
                position: 'relative', width: '100%', flex: 1,
                overflow: 'hidden', background: '#f1f5f9',
            }}>
                {/* Floating Live Status Pill */}
                {isCameraReady && (
                    <div style={{
                        position: 'absolute', top: 16, left: 16, zIndex: 25,
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: 'rgba(255, 255, 255, 0.92)', backdropFilter: 'blur(8px)',
                        padding: '6px 12px', borderRadius: 20, border: '1px solid #e2e8f0',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                    }}>
                        <div style={{
                            width: 8, height: 8, borderRadius: '50%', background: '#ef4444',
                            boxShadow: '0 0 6px #ef4444', animation: 'blink 1s ease-in-out infinite',
                        }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>
                            RECORDING 15 FPS • {liveFrameCount} FRAMES
                        </span>
                    </div>
                )}

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
            </div>

            {/* ══ BOTTOM CONTROLS ("END DETECTION" BUTTON) ══ */}
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 12, padding: '16px 20px 20px',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
                background: '#ffffff', borderTop: '1px solid #e2e8f0',
                boxShadow: '0 -2px 10px rgba(0,0,0,0.02)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 480 }}>
                    {/* Live Metrics */}
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
                            15 FPS Live
                        </div>
                    </div>

                    {/* ══ "END DETECTION" BUTTON ══ */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <button
                            onClick={handleEndDetection}
                            disabled={!isCameraReady}
                            title="End Detection & View All Frames"
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                                padding: '14px 28px', borderRadius: 16,
                                background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                color: '#ffffff', border: 'none',
                                cursor: !isCameraReady ? 'not-allowed' : 'pointer',
                                opacity: !isCameraReady ? 0.6 : 1,
                                boxShadow: '0 4px 16px rgba(239, 68, 68, 0.4)',
                                transition: 'all 0.15s ease',
                            }}
                        >
                            <div style={{ width: 14, height: 14, background: '#ffffff', borderRadius: 3 }} />
                            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.02em' }}>
                                End Detection
                            </span>
                        </button>
                        <span style={{ color: '#64748b', fontSize: 11, fontWeight: 600 }}>
                            {liveFrameCount} frames captured @ 15 FPS
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
      `}</style>
        </div>
    );
};

export const CameraCaptureIOS: React.FC<CameraCaptureProps> = CameraCaptureAndroid;

// ═════════════════════════════════════════════════════════════════════════════
// ─── MASTER COMPONENT: LANDING SCREEN WITH DETECT BUTTON & CAPTURED FRAMES ────
// ═════════════════════════════════════════════════════════════════════════════
const Home: React.FC = () => {
    const [activeScreen, setActiveScreen] = useState<'dashboard' | 'scanner'>('dashboard');
    const [capturedFrames, setCapturedFrames] = useState<CapturedFrame[]>([]);

    // Modal viewers
    const [selectedFrame, setSelectedFrame] = useState<CapturedFrame | null>(null);
    const [isPlayingSequence, setIsPlayingSequence] = useState(false);
    const [playbackIndex, setPlaybackIndex] = useState(0);
    const [isAutoPlaying, setIsAutoPlaying] = useState(false);

    // Flipbook player timer for 15 FPS playback
    useEffect(() => {
        let timer: number | null = null;
        if (isPlayingSequence && isAutoPlaying && capturedFrames.length > 0) {
            const frameDelay = Math.round(1000 / 15);
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

    return (
        <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: "'DM Sans', sans-serif", color: '#0f172a', position: 'relative' }}>
            {/* ═══ SCREEN 2: LIVE CAMERA SCANNER (AUTO 15 FPS CAPTURE + END DETECTION) ═══ */}
            {activeScreen === 'scanner' && (
                <CameraCaptureAndroid
                    onClose={() => setActiveScreen('dashboard')}
                    onCaptureFrames={handleCapturedFrames}
                />
            )}

            {/* ═══ SCREEN 1: LANDING SCREEN ═══ */}
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
                                        AI READY
                                    </span>
                                </div>
                                <p style={{ fontSize: 13, color: '#64748b', margin: '3px 0 0' }}>
                                    Continuous 15 FPS live scanning with end detection & frame gallery
                                </p>
                            </div>
                        </div>

                        {/* Top quick metrics */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                                padding: '8px 14px', borderRadius: 10, background: '#ffffff',
                                border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                            }}>
                                <span style={{ fontSize: 11, color: '#64748b', display: 'block' }}>Scan Rate</span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>15 FPS (Continuous)</span>
                            </div>
                            {capturedFrames.length > 0 && (
                                <div style={{
                                    padding: '8px 14px', borderRadius: 10, background: '#ffffff',
                                    border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                                }}>
                                    <span style={{ fontSize: 11, color: '#64748b', display: 'block' }}>Captured</span>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: '#047857' }}>{capturedFrames.length} Frames</span>
                                </div>
                            )}
                        </div>
                    </header>

                    {/* ══ HERO CARD: "CLICK HERE TO DETECT DEFECT" ══ */}
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
                        <div style={{ maxWidth: 560 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 6,
                                    fontSize: 12, fontWeight: 700, color: '#047857',
                                    background: '#d1fae5', padding: '4px 10px', borderRadius: 20,
                                }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                                    Live Auto-Scanner
                                </span>
                                <span style={{ fontSize: 12, color: '#64748b' }}>• Starts recording 15 FPS immediately</span>
                            </div>
                            <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px', color: '#0f172a', letterSpacing: '-0.02em' }}>
                                Start Live Scanning & Defect Capture
                            </h2>
                            <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.5, margin: 0 }}>
                                Opens the camera screen, automatically records 15 frames per second continuously, and saves all frames when you press <strong>End Detection</strong>.
                            </p>
                        </div>

                        {/* Primary Button */}
                        <button
                            onClick={() => setActiveScreen('scanner')}
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                                padding: '16px 30px', borderRadius: 14,
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
                    </div>

                    {/* ═══ CAPTURED FRAMES SECTION ON LANDING SCREEN ═══ */}
                    {capturedFrames.length > 0 ? (
                        <div>
                            {/* Toolbar */}
                            <div style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                flexWrap: 'wrap', gap: 12, marginBottom: 18,
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0f172a' }}>
                                        All Captured Frames
                                    </h3>
                                    <span style={{
                                        fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                                        background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0',
                                    }}>
                                        {capturedFrames.length} Frames @ 15 FPS
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
                                gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
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
                                Click <strong>"Click here to detect defect"</strong> above. The camera will automatically start capturing at 15 FPS, and pressing <strong>End Detection</strong> will display all frames here.
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
                                            Live Sequence Playback (15 FPS)
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
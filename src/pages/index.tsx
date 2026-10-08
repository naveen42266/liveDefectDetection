import { useState, useRef, useEffect, useCallback } from 'react';
// import InstructionVideo from "../../assets/instruction_video.mp4";
// import InstructionImg from "../../assets/instruction_img.jpeg";

// ─── CAMERA METRICS & TYPES ──────────────────────────────────────────────────
export interface CameraMetrics {
    width?: number;
    height?: number;
    frameRate?: number;
    aspectRatio?: number;
    facingMode?: string;
    displayAspect?: string;
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
    onCapture: (videoUrl: string, mimeType: string) => void;
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

// Determine best supported MediaRecorder MIME type (Prioritizing MP4 H.264 for universal gallery playback)
const getSupportedRecorderMimeType = (): string => {
    const candidates = [
        'video/mp4;codecs=avc1.4d002a',
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4',
        'video/webm;codecs=h264',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp8',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp9',
        'video/webm',
    ];

    for (const type of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }
    return '';
};

// Calculate practical adaptive bitrate based on negotiated resolution & frame rate
const calculateAdaptiveBitrate = (width?: number, height?: number, frameRate?: number): number => {
    const w = width || 1080;
    const h = height || 1920;
    const fps = frameRate || 30;
    const totalPixelsPerSec = w * h * fps;

    const targetBitrate = Math.round(totalPixelsPerSec * 0.10);
    return Math.min(Math.max(targetBitrate, 1_500_000), 8_000_000);
};

/**
 * Injects duration metadata into a WebM Blob so Android/Samsung Gallery
 * and native media players can determine duration and play/seek the video without "Can't play video" errors.
 */
async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
    if (durationMs <= 0) return blob;
    try {
        const buffer = await blob.arrayBuffer();
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        for (let i = 0; i < bytes.length - 12; i++) {
            if (
                bytes[i] === 0x15 &&
                bytes[i + 1] === 0x49 &&
                bytes[i + 2] === 0xa9 &&
                bytes[i + 3] === 0x66
            ) {
                const limit = Math.min(i + 250, bytes.length - 8);
                for (let j = i + 4; j < limit; j++) {
                    if (bytes[j] === 0x44 && bytes[j + 1] === 0x89) {
                        const lengthByte = bytes[j + 2];
                        if (lengthByte === 0x84 && j + 7 <= bytes.length) {
                            view.setFloat32(j + 3, durationMs, false);
                            return new Blob([buffer], { type: blob.type });
                        }
                        if (lengthByte === 0x88 && j + 11 <= bytes.length) {
                            view.setFloat64(j + 3, durationMs, false);
                            return new Blob([buffer], { type: blob.type });
                        }
                    }
                }
                break;
            }
        }
    } catch (err) {
        console.warn('WebM duration metadata patch skipped:', err);
    }
    return blob;
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── 1. ANDROID DEDICATED CAMERA CAPTURE (PROVEN WORKING CODE) ───────────────
// ═════════════════════════════════════════════════════════════════════════════

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

const CameraCaptureAndroid: React.FC<CameraCaptureProps> = ({ onClose, onCapture }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const trackRef = useRef<MediaStreamTrack | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const recorderChunksRef = useRef<Blob[]>([]);
    const mimeTypeRef = useRef<string>('');
    const recordingDurationRef = useRef<number>(0);

    const [isCameraReady, setIsCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [flashSupported, setFlashSupported] = useState(false);
    const [isFlashOn, setIsFlashOn] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [cameraMetrics, setCameraMetrics] = useState<CameraMetrics>({});

    const durationIntervalRef = useRef<number | null>(null);

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

    const [viewportHeight, setViewportHeight] = useState<number | null>(null);

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

                        try {
                            const capabilities = (typeof track.getCapabilities === 'function'
                                ? track.getCapabilities()
                                : {}) as ExtendedMediaTrackCapabilities;
                            if (capabilities.torch === true || 'torch' in capabilities) {
                                const adv: ExtendedMediaTrackConstraintSet = { torch: true };
                                await track.applyConstraints({
                                    advanced: [adv as MediaTrackConstraintSet],
                                });
                                setIsFlashOn(true);
                            }
                        } catch (torchErr) {
                            console.warn('Initial flash auto-enable skipped/error:', torchErr);
                        }
                    };
                }
            } catch (error) {
                console.error('Camera initialization failed:', error);
                alert('Camera access denied or unavailable. Please check permissions.');
                onClose();
            }
        };

        void startCamera();

        return () => {
            cancelled = true;

            if (trackRef.current) {
                try {
                    const adv: ExtendedMediaTrackConstraintSet = { torch: false };
                    void trackRef.current.applyConstraints({
                        advanced: [adv as MediaTrackConstraintSet],
                    });
                } catch { }
            }

            streamRef.current?.getTracks().forEach(track => track.stop());

            if (durationIntervalRef.current) {
                clearInterval(durationIntervalRef.current);
                durationIntervalRef.current = null;
            }
        };
    }, [onClose, extractCameraDiagnostics]);

    const startRecording = () => {
        if (!streamRef.current || isRecording || !isCameraReady) return;
        actuallyStartRecording();
    };

    const startDirectMediaRecorder = (): boolean => {
        const stream = streamRef.current;
        if (!stream) return false;

        const track = stream.getVideoTracks()[0];
        const settings = track ? track.getSettings() : {};
        const nativeWidth = settings.width || cameraMetrics.width || 1080;
        const nativeHeight = settings.height || cameraMetrics.height || 1920;

        // DIRECT STREAM RECORDING: records the native 1080x1920 portrait stream directly from sensor
        const mimeType = getSupportedRecorderMimeType();
        const targetBitrate = calculateAdaptiveBitrate(
            nativeWidth,
            nativeHeight,
            settings.frameRate || cameraMetrics.frameRate
        );

        let recorder: MediaRecorder | null = null;

        if (mimeType) {
            try {
                recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitrate });
            } catch {
                try {
                    recorder = new MediaRecorder(stream, { mimeType });
                } catch {
                    recorder = null;
                }
            }
        }
        if (!recorder) {
            try {
                recorder = new MediaRecorder(stream);
            } catch (err) {
                console.error('MediaRecorder initialization failed:', err);
                return false;
            }
        }

        recorderChunksRef.current = [];
        mimeTypeRef.current = recorder.mimeType || mimeType || 'video/webm';
        recorderRef.current = recorder;
        recordingDurationRef.current = 0;

        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) {
                recorderChunksRef.current.push(event.data);
            }
        };

        recorder.onerror = (event) => {
            console.error('MediaRecorder error:', event);
        };

        recorder.onstop = async () => {
            const actualType = mimeTypeRef.current || 'video/webm';
            let blob = new Blob(recorderChunksRef.current, { type: actualType });

            if (blob.size === 0) {
                console.error('Recording produced an empty video.');
                setIsProcessing(false);
                return;
            }

            if (actualType.includes('webm')) {
                const durationMs = (recordingDurationRef.current || 1) * 1000;
                blob = await fixWebmDuration(blob, durationMs);
            }

            setIsProcessing(false);
            onCapture(URL.createObjectURL(blob), actualType);
        };

        recorder.start(1000);
        return true;
    };

    const actuallyStartRecording = () => {
        if (!streamRef.current || !videoRef.current) return;

        const started = startDirectMediaRecorder();
        if (!started) {
            setIsProcessing(false);
            alert('Unable to record the camera stream on this device.');
            return;
        }

        if ('vibrate' in navigator) navigator.vibrate(200);

        setRecordingDuration(0);
        recordingDurationRef.current = 0;
        durationIntervalRef.current = window.setInterval(() => {
            setRecordingDuration(prev => {
                const nextVal = prev + 1;
                recordingDurationRef.current = nextVal;
                return nextVal;
            });
        }, 1000);

        setIsRecording(true);
    };

    const stopRecording = () => {
        if (!isRecording) return;

        if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
        }

        setIsRecording(false);
        setIsProcessing(true);

        const recorder = recorderRef.current;
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
        } else {
            setIsProcessing(false);
        }
    };

    const formatDuration = (s: number) =>
        `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

    const progress = Math.min((recordingDuration / 60) * 100, 100);

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
                        disabled={isRecording || isProcessing}
                        style={{
                            width: 42, height: 42, borderRadius: 12,
                            background: '#f1f5f9', border: '1px solid #e2e8f0',
                            color: (isRecording || isProcessing) ? '#94a3b8' : '#1e293b',
                            fontSize: 18, cursor: (isRecording || isProcessing) ? 'not-allowed' : 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.15s ease',
                        }}
                    >✕</button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: isRecording ? '#ef4444' : '#10b981',
                            boxShadow: isRecording ? '0 0 8px rgba(239,68,68,0.8)' : '0 0 8px rgba(16,185,129,0.8)',
                            animation: 'blink 1s ease-in-out infinite',
                        }} />
                        <span style={{ color: '#334155', fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', fontFamily: 'monospace' }}>
                            {isRecording ? 'REC' : 'Live Detection'}
                        </span>
                    </div>

                    <div style={{
                        padding: '6px 14px', borderRadius: 20,
                        background: isRecording ? '#fee2e2' : '#f1f5f9',
                        border: `1px solid ${isRecording ? '#fca5a5' : '#e2e8f0'}`,
                    }}>
                        <span style={{ color: isRecording ? '#dc2626' : '#1e293b', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
                            {isRecording ? formatDuration(recordingDuration) : '0:00'}
                        </span>
                    </div>
                </div>
            </div>

            {/* ══ PORTRAIT VIEWFINDER (CLEAN VIDEO, NO OVERLAY LINES OR INSTRUCTIONS) ══ */}
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
                        <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill={isFlashOn ? '#eab308' : 'none'}
                            stroke={isFlashOn ? '#eab308' : 'currentColor'}
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
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

            {/* ══ BOTTOM CONTROLS (LIGHT THEME) ══ */}
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 12, padding: '16px 24px 20px',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
                background: '#ffffff', borderTop: '1px solid #e2e8f0',
                boxShadow: '0 -2px 10px rgba(0,0,0,0.02)',
            }}>
                {isRecording && (
                    <div style={{ width: '100%', maxWidth: 220 }}>
                        <div style={{ width: '100%', height: 4, borderRadius: 2, background: '#e2e8f0', overflow: 'hidden', marginBottom: 5 }}>
                            <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #10b981, #059669)', width: `${progress}%`, transition: 'width 1s linear' }} />
                        </div>
                        <span style={{ color: '#64748b', fontSize: 11, fontWeight: 500 }}>Recording: {formatDuration(recordingDuration)}</span>
                    </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{
                        display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 12px',
                        borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0',
                        minWidth: 120,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
                            <span style={{ color: '#0f172a', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
                                {cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'ADAPTIVE'}
                            </span>
                        </div>
                        <div style={{ color: '#64748b', fontSize: 10, fontFamily: 'monospace' }}>
                            {cameraMetrics.frameRate ? `${cameraMetrics.frameRate} FPS` : 'FPS: Auto'} • {cameraMetrics.displayAspect || '9:16'}
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        {!isRecording ? (
                            <button onClick={startRecording} disabled={!isCameraReady || isProcessing}
                                style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: (!isCameraReady || isProcessing) ? 'not-allowed' : 'pointer', opacity: (!isCameraReady || isProcessing) ? 0.4 : 1 }}>
                                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid #cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
                                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 16px rgba(16,185,129,0.45)' }} />
                                </div>
                            </button>
                        ) : (
                            <button onClick={stopRecording} style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid #fca5a5', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fef2f2' }}>
                                    <div style={{ width: 44, height: 44, borderRadius: 8, background: '#ef4444', boxShadow: '0 0 16px rgba(239,68,68,0.45)' }} />
                                </div>
                            </button>
                        )}
                        <span style={{ color: isRecording ? '#dc2626' : '#64748b', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', animation: isRecording ? 'blink 1s ease-in-out infinite' : 'none' }}>
                            {isRecording ? '● STOP' : isCameraReady ? 'TAP TO SCAN' : 'LOADING...'}
                        </span>
                    </div>

                    <div style={{ minWidth: 120, display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ color: '#94a3b8', fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', fontWeight: 600 }}>
                            {cameraMetrics.facingMode || 'REAR'}
                        </span>
                    </div>
                </div>
            </div>

            {isProcessing && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.3s ease', zIndex: 60, overflow: 'auto' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, animation: 'scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1)', padding: '36px 28px', maxWidth: 400, width: '90%', background: '#ffffff', borderRadius: 20, border: '1px solid #e2e8f0', boxShadow: '0 20px 40px rgba(0,0,0,0.08)' }}>
                        <div style={{ width: 68, height: 68, borderRadius: '50%', background: 'rgba(16,185,129,0.1)', border: '2px solid rgba(16,185,129,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <div style={{ width: 30, height: 30, border: '3px solid rgba(16,185,129,0.2)', borderTopColor: '#10b981', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} />
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <p style={{ color: '#0f172a', fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Finalising Scan</p>
                            <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
                                Processing video for tread analysis…
                            </p>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
        @keyframes blink    { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes fadeIn   { from{opacity:0} to{opacity:1} }
        @keyframes scaleIn  { from{transform:scale(0.8);opacity:0} to{transform:scale(1);opacity:1} }
        @keyframes spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
        </div>
    );
};

// ═════════════════════════════════════════════════════════════════════════════
// ─── 2. IPHONE (IOS) CAMERA CAPTURE (UNIFIED WITH PROVEN ENGINE) ─────────────
// ═════════════════════════════════════════════════════════════════════════════
export const CameraCaptureIOS: React.FC<CameraCaptureProps> = CameraCaptureAndroid;


const Home: React.FC = () => {
    return (
        <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: "'DM Sans', sans-serif", color: '#0f172a', position: 'relative', overflow: 'hidden' }}>
            <CameraCaptureAndroid
                onClose={() => { }}
                onCapture={(_videoUrl, _mimeType) => {
                }}
            />

            <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
        </div>
    );
};

export default Home;
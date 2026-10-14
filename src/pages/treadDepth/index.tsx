import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    Camera,
    CheckCircle,
    RefreshCw,
    AlertTriangle,
    Download,
} from 'lucide-react';

interface TyreDepthProps {
    onCapture: (imageDataUrl: string) => void;
}

const TyreDepth: React.FC<TyreDepthProps> = ({
    onCapture,
}) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const [hasPermission, setHasPermission] = useState<boolean | null>(null);
    const [isStreamActive, setIsStreamActive] = useState<boolean>(false);
    const [capturedImage, setCapturedImage] = useState<string | null>(null);
    const [isSteady, setIsSteady] = useState<boolean>(false);

    // Initialize camera stream
    useEffect(() => {
        let mounted = true;

        const startCamera = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: 'environment',
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                });

                if (!mounted) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }

                streamRef.current = stream;

                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    await videoRef.current.play();
                }

                setIsStreamActive(true);
                setHasPermission(true);
            } catch (error) {
                console.error('Error accessing camera:', error);

                if (mounted) {
                    setHasPermission(false);
                    setIsStreamActive(false);
                }
            }
        };

        startCamera();

        return () => {
            mounted = false;

            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        };
    }, []);

    // Capture the current camera frame
    const captureImage = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;

        if (
            !video ||
            !canvas ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            !video.videoWidth ||
            !video.videoHeight
        ) {
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext('2d');

        if (!context) return;

        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageDataUrl = canvas.toDataURL('image/jpeg', 0.95);

        setCapturedImage(imageDataUrl);
        onCapture(imageDataUrl);
    }, [onCapture]);

    // Download the captured image
    const downloadImage = useCallback(() => {
        if (!capturedImage) return;

        const link = document.createElement('a');

        link.href = capturedImage;
        link.download = `tyre-tread-${new Date()
            .toISOString()
            .replace(/[:.]/g, '-')}.jpg`;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }, [capturedImage]);

    // Return to the live camera preview
    const retakeImage = useCallback(() => {
        setCapturedImage(null);
    }, []);

    // Confirm the captured image for measurement
    const confirmImage = useCallback(() => {
        if (!capturedImage) return;

        // The image has already been passed to onCapture.
        // Replace this alert with your measurement/navigation logic.
        alert('Image successfully locked for processing!');
    }, [capturedImage]);

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-4">
            <div className="w-full max-w-md bg-slate-900 rounded-2xl overflow-hidden shadow-2xl border border-slate-800">

                {/* Header */}
                <div className="p-4 border-b border-slate-800 flex justify-between items-center gap-2">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Camera className="w-5 h-5 text-indigo-400" />
                        TreadSense Capture
                    </h2>

                    <span className="text-xs px-2.5 py-1 bg-indigo-500/10 text-indigo-400 rounded-full font-medium border border-indigo-500/20 whitespace-nowrap">
                        Option 1 Mode
                    </span>
                </div>

                {/* Camera / Image Preview */}
                <div className="relative w-full aspect-[3/4] bg-black flex items-center justify-center overflow-hidden">

                    {hasPermission === false ? (
                        <div className="text-center p-6 text-red-400 flex flex-col items-center gap-2">
                            <AlertTriangle className="w-8 h-8" />

                            <p className="text-sm font-medium">
                                Camera permission denied or unavailable.
                            </p>

                            <p className="text-xs text-slate-400">
                                Please enable camera permissions in your browser settings
                                and reload the page.
                            </p>
                        </div>
                    ) : capturedImage ? (
                        <>
                            <img
                                src={capturedImage}
                                alt="Captured Tyre Tread"
                                className="w-full h-full object-contain"
                            />

                            <div className="absolute top-3 left-3">
                                <span className="text-xs font-semibold px-3 py-1.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4" />
                                    Image Captured
                                </span>
                            </div>
                        </>
                    ) : (
                        <>
                            <video
                                ref={videoRef}
                                playsInline
                                muted
                                autoPlay
                                className="w-full h-full object-cover"
                            />

                            {/* Tyre Alignment Overlay */}
                            {hasPermission !== false && (
                                <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-8">
                                    <div className="w-full max-w-64 aspect-[4/3] border-2 border-dashed border-indigo-400/80 rounded-xl relative flex items-center justify-center bg-indigo-500/5 backdrop-blur-[2px]">

                                        <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-indigo-400" />

                                        <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-indigo-400" />

                                        <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-indigo-400" />

                                        <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-indigo-400" />

                                        <span className="text-xs font-semibold text-indigo-200 bg-slate-900/80 px-3 py-2 rounded-md text-center shadow-lg border border-indigo-500/30">
                                            Align Main Grooves Here
                                        </span>
                                    </div>
                                </div>
                            )}

                            {hasPermission === null && (
                                <div className="absolute bottom-4 left-0 right-0 text-center">
                                    <span className="text-xs bg-slate-950/80 text-slate-300 px-3 py-2 rounded-full">
                                        Initializing camera...
                                    </span>
                                </div>
                            )}
                        </>
                    )}

                    <canvas ref={canvasRef} className="hidden" />
                </div>

                {/* Pre-Capture Criteria */}
                {!capturedImage && (
                    <div className="p-4 bg-slate-900/90 border-t border-slate-800 space-y-3">
                        <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                            Pre-Capture Criteria Check
                        </div>

                        <div className="space-y-3">
                            <label className="flex items-center gap-3 text-sm text-slate-300 select-none">
                                <input
                                    type="checkbox"
                                    checked={isStreamActive}
                                    disabled
                                    className="w-4 h-4 rounded border-slate-700 text-indigo-600 focus:ring-indigo-500 bg-slate-800"
                                />

                                <span>Camera feed active</span>
                            </label>

                            <label className="flex items-center gap-3 text-sm text-slate-300 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={isSteady}
                                    onChange={(event) => setIsSteady(event.target.checked)}
                                    className="w-4 h-4 rounded border-slate-700 text-indigo-600 focus:ring-indigo-500 bg-slate-800"
                                />

                                <span>Spacer / shroud seated flush against tread</span>
                            </label>
                        </div>

                        {/* Capture Button */}
                        <button
                            onClick={captureImage}
                            disabled={!isStreamActive || !isSteady}
                            className={`w-full mt-2 py-3 px-4 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all ${isStreamActive && isSteady
                                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30'
                                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50'
                                }`}
                        >
                            <Camera className="w-5 h-5" />
                            Capture Tread Frame
                        </button>

                        {!isSteady && isStreamActive && (
                            <p className="text-xs text-center text-slate-500">
                                Seat the spacer / shroud against the tread before capturing.
                            </p>
                        )}
                    </div>
                )}

                {/* Post-Capture Actions */}
                {capturedImage && (
                    <div className="p-4 bg-slate-900 border-t border-slate-800 space-y-3">

                        {/* Save / Download Button */}
                        <button
                            onClick={downloadImage}
                            className="w-full py-3 px-4 rounded-xl font-semibold bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30 transition-all"
                        >
                            <Download className="w-5 h-5" />
                            Save / Download Image
                        </button>

                        {/* Retake and Confirm Buttons */}
                        <div className="flex gap-3">
                            <button
                                onClick={retakeImage}
                                className="flex-1 py-3 px-3 rounded-xl font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center gap-2 border border-slate-700 transition-all"
                            >
                                <RefreshCw className="w-4 h-4 shrink-0" />
                                Retake
                            </button>

                            <button
                                onClick={confirmImage}
                                className="flex-1 py-3 px-3 rounded-xl font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/30 transition-all"
                            >
                                <CheckCircle className="w-4 h-4 shrink-0" />
                                Confirm & Measure
                            </button>
                        </div>

                        <p className="text-xs text-center text-slate-500">
                            Save the captured JPEG to your device or confirm it for processing.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TyreDepth;
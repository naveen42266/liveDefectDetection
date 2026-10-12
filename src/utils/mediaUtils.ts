import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// ─── UTILITY: CONVERT RECORDED BLOB TO REAL STANDARD MP4 (H.264/AVC) ──────────
export async function convertBlobToMp4(blob: Blob): Promise<Blob> {
    if (typeof window === 'undefined') return blob;
    if (blob.type === 'video/mp4' && !blob.type.includes('webm')) {
        return blob;
    }
    if (typeof VideoEncoder === 'undefined') {
        return blob;
    }

    return new Promise(async (resolve) => {
        try {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(blob);
            video.muted = true;
            video.playsInline = true;

            await new Promise<void>((res) => {
                video.onloadedmetadata = () => res();
                video.onerror = () => res();
                setTimeout(res, 3000);
            });

            const width = video.videoWidth || 1080;
            const height = video.videoHeight || 1920;
            const duration = (video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration : 8;
            const fps = 30;
            const totalFrames = Math.max(1, Math.round(duration * fps));

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                resolve(blob);
                return;
            }

            const muxer = new Muxer({
                target: new ArrayBufferTarget(),
                video: {
                    codec: 'avc',
                    width,
                    height,
                    frameRate: fps,
                },
                fastStart: 'in-memory',
                firstTimestampBehavior: 'offset',
            });

            let avcCodec = 'avc1.42001f';
            if (typeof VideoEncoder.isConfigSupported === 'function') {
                try {
                    const check = await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width, height, bitrate: 3_000_000, framerate: fps });
                    if (!check.supported) {
                        const check2 = await VideoEncoder.isConfigSupported({ codec: 'avc1.4d002a', width, height, bitrate: 3_000_000, framerate: fps });
                        if (check2.supported) avcCodec = 'avc1.4d002a';
                    }
                } catch { }
            }

            const encoder = new VideoEncoder({
                output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
                error: (e) => console.error('VideoEncoder error:', e),
            });

            encoder.configure({
                codec: avcCodec,
                width,
                height,
                bitrate: 3_000_000,
                framerate: fps,
            });

            for (let i = 0; i < totalFrames; i++) {
                const currentTime = (i / totalFrames) * duration;
                video.currentTime = currentTime;
                await new Promise<void>((res) => {
                    const onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked);
                        res();
                    };
                    video.addEventListener('seeked', onSeeked);
                    setTimeout(res, 80);
                });

                ctx.drawImage(video, 0, 0, width, height);
                const frame = new VideoFrame(canvas, {
                    timestamp: Math.round((i / fps) * 1_000_000),
                });
                const keyFrame = i % 30 === 0;
                encoder.encode(frame, { keyFrame });
                frame.close();
            }

            await encoder.flush();
            encoder.close();
            muxer.finalize();

            const mp4Blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            URL.revokeObjectURL(video.src);
            resolve(mp4Blob);
        } catch (err) {
            console.warn('convertBlobToMp4 failed, using original blob:', err);
            resolve(blob);
        }
    });
}

// ─── UTILITY: DETECT IOS / IPHONE ─────────────────────────────────────────────
export const isIOSDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
};

// ─── UTILITY: DOWNLOAD FRAME WITH ACTIVE DEFECT ANNOTATIONS ───────────────────
import { getZoneTheme, DetectApiResponse } from '../services/defectDetectionApi';

export interface DownloadAnnotationOptions {
    showPolygons: boolean;
    showBboxes: boolean;
    showLabels: boolean;
}

export async function downloadAnnotatedFrame(
    frame: {
        frameIndex: number;
        dataUrl: string;
        width: number;
        height: number;
        detection?: DetectApiResponse | null;
    },
    options: DownloadAnnotationOptions = { showPolygons: true, showBboxes: true, showLabels: true }
): Promise<void> {
    const hasLayers = options.showPolygons || options.showBboxes || options.showLabels;
    const hasZones = frame.detection?.zones && Object.keys(frame.detection.zones).length > 0;

    // If no layers active or no detection, download raw image immediately
    if (!hasLayers || !hasZones) {
        const link = document.createElement('a');
        link.href = frame.dataUrl;
        link.download = `defect_frame_${frame.frameIndex}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
    }

    try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to load image for canvas download'));
            img.src = frame.dataUrl;
        });

        const canvas = document.createElement('canvas');
        const width = img.naturalWidth || frame.width || 1080;
        const height = img.naturalHeight || frame.height || 1920;
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Draw original base frame
        ctx.drawImage(img, 0, 0, width, height);

        // Dynamic coordinate scaling matching FrameDetectionOverlay
        const baseFontSize = Math.max(30, Math.round(width * 0.036));
        const badgeH = Math.max(44, Math.round(baseFontSize * 1.55));
        const badgePaddingX = Math.max(14, Math.round(baseFontSize * 0.65));
        const strokeWidthPoly = Math.max(4, Math.round(width * 0.005));
        const strokeWidthBox = Math.max(3, Math.round(width * 0.0035));
        const badgeRadius = Math.max(6, Math.round(baseFontSize * 0.22));
        const badgeBorderWidth = Math.max(1.5, Math.round(baseFontSize * 0.06));

        const zones = Object.entries(frame.detection!.zones || {});

        // 1. Polygons Layer
        if (options.showPolygons) {
            for (const [zoneKey, zoneData] of zones) {
                const theme = getZoneTheme(zoneKey);
                if (zoneData.polygons && zoneData.polygons.length > 0) {
                    for (const poly of zoneData.polygons) {
                        if (poly.length < 2) continue;
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(poly[0][0], poly[0][1]);
                        for (let i = 1; i < poly.length; i++) {
                            ctx.lineTo(poly[i][0], poly[i][1]);
                        }
                        ctx.closePath();
                        ctx.fillStyle = theme.fill;
                        ctx.fill();
                        ctx.strokeStyle = theme.stroke;
                        ctx.lineWidth = strokeWidthPoly;
                        ctx.lineJoin = 'round';
                        ctx.stroke();
                        ctx.restore();
                    }
                }
            }
        }

        // 2. Bounding Boxes Layer
        if (options.showBboxes) {
            for (const [zoneKey, zoneData] of zones) {
                const theme = getZoneTheme(zoneKey);
                if (zoneData.bbox) {
                    const [x1, y1, x2, y2] = zoneData.bbox;
                    const boxW = Math.max(0, x2 - x1);
                    const boxH = Math.max(0, y2 - y1);
                    ctx.save();
                    ctx.strokeStyle = theme.stroke;
                    ctx.lineWidth = strokeWidthBox;
                    ctx.setLineDash([strokeWidthBox * 3, strokeWidthBox * 1.5]);
                    ctx.strokeRect(x1, y1, boxW, boxH);
                    ctx.restore();
                }
            }
        }

        // 3. Labels & Confidence Badges Layer
        if (options.showLabels) {
            for (const [zoneKey, zoneData] of zones) {
                const theme = getZoneTheme(zoneKey);
                if (zoneData.bbox) {
                    const [x1, y1] = zoneData.bbox;
                    const confPercent = (zoneData.confidence * 100).toFixed(1);
                    const labelText = `${theme.name} ${confPercent}%`;

                    ctx.save();
                    ctx.font = `800 ${baseFontSize}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
                    const textWidth = ctx.measureText(labelText).width;
                    const badgeW = Math.round(textWidth + badgePaddingX * 2);

                    const badgeY = y1 > badgeH + 8 ? y1 - badgeH - 8 : Math.min(height - badgeH - 4, y1 + 8);
                    const badgeX = Math.max(4, Math.min(width - badgeW - 4, x1));

                    ctx.fillStyle = theme.stroke;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = badgeBorderWidth;

                    if (typeof ctx.roundRect === 'function') {
                        ctx.beginPath();
                        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeRadius);
                        ctx.fill();
                        ctx.stroke();
                    } else {
                        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
                        ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
                    }

                    ctx.fillStyle = '#ffffff';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(labelText, badgeX + badgePaddingX, badgeY + Math.round(badgeH * 0.52));
                    ctx.restore();
                }
            }
        }

        const annotatedUrl = canvas.toDataURL('image/jpeg', 0.95);
        const link = document.createElement('a');
        link.href = annotatedUrl;
        link.download = `defect_frame_${frame.frameIndex}_annotated.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (err) {
        console.warn('Canvas annotation export failed, downloading raw frame:', err);
        const link = document.createElement('a');
        link.href = frame.dataUrl;
        link.download = `defect_frame_${frame.frameIndex}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

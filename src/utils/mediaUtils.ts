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

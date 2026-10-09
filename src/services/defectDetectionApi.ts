// ─── DEFECT DETECTION API SERVICE ──────────────────────────────────────────
export const API_BASE_URL = 'https://www.radometechtreadvision.com/api/';
export const AREA_DETECT_ENDPOINT = `${API_BASE_URL}area/detect/`;

export interface ZoneDetail {
    confidence: number;
    area_fraction: number;
    bbox: [number, number, number, number]; // [x1, y1, x2, y2]
    polygons: [number, number][][]; // array of polygons, each with [x, y] points
}

export interface DetectApiResponse {
    success: boolean;
    frame_id?: string;
    route?: string;
    fast_stream?: boolean;
    image_size?: {
        width: number;
        height: number;
    };
    detected_zones?: string[];
    zones?: Record<string, ZoneDetail>;
    inference_time_ms?: number;
    total_time_ms?: number;
    error?: string;
}

/**
 * Converts a base64 DataURL (image/jpeg, etc.) to a binary Blob for FormData upload
 */
export function dataUrlToBlob(dataUrl: string): Blob {
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const binaryStr = atob(parts[1]);
    const len = binaryStr.length;
    const u8arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        u8arr[i] = binaryStr.charCodeAt(i);
    }
    return new Blob([u8arr], { type: mime });
}

/**
 * Sends a frame (Blob or base64 dataUrl) to the defect detection API:
 * POST https://www.radometechtreadvision.com/api/area/detect/
 * Form Data:
 *   key: 'frame'
 */
export async function detectAreaDefects(frame: Blob | string): Promise<DetectApiResponse> {
    const blob = typeof frame === 'string' ? dataUrlToBlob(frame) : frame;
    const formData = new FormData();
    formData.append('frame', blob, 'frame.jpg');

    const response = await fetch(AREA_DETECT_ENDPOINT, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
        try {
            const errData = await response.json();
            if (errData?.error) {
                errorMsg = errData.error;
            }
        } catch {
            // Ignore json parse error
        }
        throw new Error(errorMsg);
    }

    const data: DetectApiResponse = await response.json();
    return data;
}

/**
 * Visual styling token helper for detected zone types
 */
export function getZoneTheme(zoneName: string) {
    const normalized = zoneName.toLowerCase().trim();
    if (normalized.includes('tread')) {
        return {
            name: 'Tread Shoulder',
            stroke: '#10b981', // emerald-500
            fill: 'rgba(16, 185, 129, 0.28)',
            badgeBg: '#ecfdf5',
            badgeText: '#047857',
            border: '#a7f3d0',
        };
    }
    if (normalized.includes('bead')) {
        return {
            name: 'Bead',
            stroke: '#f59e0b', // amber-500
            fill: 'rgba(245, 158, 11, 0.28)',
            badgeBg: '#fffbeb',
            badgeText: '#b45309',
            border: '#fde68a',
        };
    }
    if (normalized.includes('sidewall')) {
        return {
            name: 'Sidewall',
            stroke: '#6366f1', // indigo-500
            fill: 'rgba(99, 102, 241, 0.28)',
            badgeBg: '#eef2ff',
            badgeText: '#4338ca',
            border: '#c7d2fe',
        };
    }
    return {
        name: zoneName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        stroke: '#0ea5e9', // sky-500
        fill: 'rgba(14, 165, 233, 0.28)',
        badgeBg: '#f0f9ff',
        badgeText: '#0369a1',
        border: '#bae6fd',
    };
}

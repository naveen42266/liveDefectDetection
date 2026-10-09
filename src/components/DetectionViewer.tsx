import React from 'react';
import {
    DetectApiResponse,
    getZoneTheme,
} from '../services/defectDetectionApi';

interface FrameDetectionOverlayProps {
    detection: DetectApiResponse;
    showPolygons: boolean;
    showBboxes: boolean;
    showLabels: boolean;
}

export const FrameDetectionOverlay: React.FC<FrameDetectionOverlayProps> = ({
    detection,
    showPolygons,
    showBboxes,
    showLabels,
}) => {
    if (!detection.zones || !detection.image_size) return null;

    const { width, height } = detection.image_size;

    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
            }}
        >
            {Object.entries(detection.zones).map(([zoneKey, zoneData]) => {
                const theme = getZoneTheme(zoneKey);
                const [x1, y1, x2, y2] = zoneData.bbox || [0, 0, 0, 0];
                const boxW = Math.max(0, x2 - x1);
                const boxH = Math.max(0, y2 - y1);
                const confPercent = (zoneData.confidence * 100).toFixed(1);

                return (
                    <g key={zoneKey} className={`zone-${zoneKey}`}>
                        {/* 1. Polygons */}
                        {showPolygons &&
                            zoneData.polygons?.map((poly, polyIdx) => (
                                <polygon
                                    key={`poly-${polyIdx}`}
                                    points={poly.map(([px, py]) => `${px},${py}`).join(' ')}
                                    fill={theme.fill}
                                    stroke={theme.stroke}
                                    strokeWidth="3.5"
                                    strokeLinejoin="round"
                                />
                            ))}

                        {/* 2. Bounding Box */}
                        {showBboxes && zoneData.bbox && (
                            <rect
                                x={x1}
                                y={y1}
                                width={boxW}
                                height={boxH}
                                fill="none"
                                stroke={theme.stroke}
                                strokeWidth="2.5"
                                strokeDasharray="8 4"
                                rx="4"
                            />
                        )}

                        {/* 3. Zone Label & Confidence Badge */}
                        {showLabels && zoneData.bbox && (
                            <g>
                                <rect
                                    x={x1}
                                    y={Math.max(0, y1 - 28)}
                                    width={Math.max(130, theme.name.length * 9.5 + 65)}
                                    height={24}
                                    fill={theme.stroke}
                                    rx="5"
                                />
                                <text
                                    x={x1 + 8}
                                    y={Math.max(0, y1 - 28) + 16}
                                    fill="#ffffff"
                                    fontSize="12.5"
                                    fontWeight="bold"
                                    fontFamily="'DM Sans', system-ui, sans-serif"
                                >
                                    {theme.name} {confPercent}%
                                </text>
                            </g>
                        )}
                    </g>
                );
            })}
        </svg>
    );
};

// ─── SCANNING ANIMATION OVERLAY ──────────────────────────────────────────────
export const ScanningOverlay: React.FC = () => {
    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.45)',
                backdropFilter: 'blur(3px)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10,
                borderRadius: '8px',
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: '3px',
                    background: 'linear-gradient(90deg, transparent, #10b981, #06b6d4, #10b981, transparent)',
                    boxShadow: '0 0 16px #10b981',
                    animation: 'scanLine 1.8s ease-in-out infinite alternate',
                }}
            />
            <div
                style={{
                    background: 'rgba(255, 255, 255, 0.95)',
                    padding: '10px 18px',
                    borderRadius: '24px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    border: '1px solid #e2e8f0',
                }}
            >
                <div
                    style={{
                        width: '14px',
                        height: '14px',
                        borderRadius: '50%',
                        border: '2.5px solid #10b981',
                        borderTopColor: 'transparent',
                        animation: 'spin 0.8s linear infinite',
                    }}
                />
                <span
                    style={{
                        fontSize: '13px',
                        fontWeight: 700,
                        color: '#0f172a',
                        letterSpacing: '0.01em',
                    }}
                >
                    Detecting Defect Zones...
                </span>
            </div>

            <style>{`
                @keyframes scanLine {
                    0% { top: 0%; }
                    100% { top: 98%; }
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

// ─── DETECTION METRICS & CONTROLS PANEL ───────────────────────────────────────
interface DetectionControlsPanelProps {
    detection: DetectApiResponse | null | undefined;
    isDetecting?: boolean;
    detectionError?: string | null;
    showPolygons: boolean;
    showBboxes: boolean;
    showLabels: boolean;
    onTogglePolygons: () => void;
    onToggleBboxes: () => void;
    onToggleLabels: () => void;
    onDetect: () => void;
}

export const DetectionControlsPanel: React.FC<DetectionControlsPanelProps> = ({
    detection,
    isDetecting,
    detectionError,
    showPolygons,
    showBboxes,
    showLabels,
    onTogglePolygons,
    onToggleBboxes,
    onToggleLabels,
    onDetect,
}) => {
    if (detectionError) {
        return (
            <div
                style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '12px',
                    padding: '14px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    margin: '12px 0 4px',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#b91c1c' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span style={{ fontSize: '13px', fontWeight: 700 }}>Detection Failed</span>
                </div>
                <p style={{ margin: 0, fontSize: '12px', color: '#7f1d1d' }}>
                    {detectionError}
                </p>
                <div>
                    <button
                        onClick={onDetect}
                        disabled={isDetecting}
                        style={{
                            padding: '6px 14px',
                            background: '#ef4444',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '8px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                        }}
                    >
                        Try Again
                    </button>
                </div>
            </div>
        );
    }

    if (!detection) {
        return (
            <div
                style={{
                    background: '#f8fafc',
                    border: '1.5px dashed #cbd5e1',
                    borderRadius: '12px',
                    padding: '16px',
                    margin: '12px 0 4px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '12px',
                    textAlign: 'center',
                }}
            >
                <div>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>
                        AI Defect Detection Available
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                        Send this frame to Radometech TreadVision API to detect tread, bead, and sidewall defect regions.
                    </div>
                </div>
                <button
                    onClick={onDetect}
                    disabled={isDetecting}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '10px 20px',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '10px',
                        fontSize: '13px',
                        fontWeight: 700,
                        cursor: isDetecting ? 'not-allowed' : 'pointer',
                        boxShadow: '0 3px 12px rgba(16, 185, 129, 0.35)',
                    }}
                >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    <span>{isDetecting ? 'Analyzing...' : 'Detect Defects (AI)'}</span>
                </button>
            </div>
        );
    }

    const zonesList = Object.entries(detection.zones || {});

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
            {/* Quick Metrics & Layer Toggles Bar */}
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    background: '#f8fafc',
                    padding: '10px 14px',
                    borderRadius: '10px',
                    border: '1px solid #e2e8f0',
                }}
            >
                {/* Metrics */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {detection.route && (
                        <span
                            style={{
                                fontSize: '11px',
                                fontWeight: 700,
                                padding: '3px 8px',
                                borderRadius: '6px',
                                background: '#ecfdf5',
                                color: '#047857',
                                border: '1px solid #a7f3d0',
                                textTransform: 'uppercase',
                            }}
                        >
                            Route: {detection.route}
                        </span>
                    )}
                    {detection.inference_time_ms !== undefined && (
                        <span
                            style={{
                                fontSize: '11px',
                                fontWeight: 600,
                                padding: '3px 8px',
                                borderRadius: '6px',
                                background: '#ffffff',
                                color: '#475569',
                                border: '1px solid #cbd5e1',
                                fontFamily: 'monospace',
                            }}
                        >
                            ⚡ {detection.inference_time_ms.toFixed(1)}ms
                        </span>
                    )}
                    <span
                        style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '6px',
                            background: '#eff6ff',
                            color: '#1d4ed8',
                            border: '1px solid #bfdbfe',
                        }}
                    >
                        {zonesList.length} Zones Detected
                    </span>
                </div>

                {/* Layer Toggle Checkboxes */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 600, color: '#334155', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={showPolygons}
                            onChange={onTogglePolygons}
                            style={{ accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        Polygons
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 600, color: '#334155', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={showBboxes}
                            onChange={onToggleBboxes}
                            style={{ accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        Boxes
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 600, color: '#334155', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={showLabels}
                            onChange={onToggleLabels}
                            style={{ accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        Labels
                    </label>
                </div>
            </div>

            {/* Zones Detailed Cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#0f172a' }}>
                    Detected Defect & Inspection Zones
                </div>
                {zonesList.length === 0 ? (
                    <div style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
                        No specific zones detected in this frame.
                    </div>
                ) : (
                    zonesList.map(([zoneKey, zoneData]) => {
                        const theme = getZoneTheme(zoneKey);
                        const confPercent = (zoneData.confidence * 100).toFixed(1);
                        const areaPercent = (zoneData.area_fraction * 100).toFixed(1);
                        const polygonCount = zoneData.polygons?.length || 0;

                        return (
                            <div
                                key={zoneKey}
                                style={{
                                    border: `1.5px solid ${theme.border}`,
                                    borderRadius: '10px',
                                    padding: '10px 14px',
                                    background: '#ffffff',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <div
                                            style={{
                                                width: '10px',
                                                height: '10px',
                                                borderRadius: '50%',
                                                background: theme.stroke,
                                            }}
                                        />
                                        <span style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>
                                            {theme.name}
                                        </span>
                                        <span
                                            style={{
                                                fontSize: '10px',
                                                padding: '2px 6px',
                                                borderRadius: '4px',
                                                background: theme.badgeBg,
                                                color: theme.badgeText,
                                                fontWeight: 700,
                                            }}
                                        >
                                            {zoneKey}
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <span style={{ fontSize: '13px', fontWeight: 800, color: theme.stroke }}>
                                            {confPercent}%
                                        </span>
                                        <span style={{ fontSize: '10px', color: '#64748b' }}>confidence</span>
                                    </div>
                                </div>

                                {/* Confidence Progress Bar */}
                                <div
                                    style={{
                                        width: '100%',
                                        height: '6px',
                                        background: '#f1f5f9',
                                        borderRadius: '3px',
                                        overflow: 'hidden',
                                    }}
                                >
                                    <div
                                        style={{
                                            width: `${confPercent}%`,
                                            height: '100%',
                                            background: theme.stroke,
                                            borderRadius: '3px',
                                            transition: 'width 0.4s ease',
                                        }}
                                    />
                                </div>

                                {/* Zone Specs Row */}
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '12px',
                                        fontSize: '11px',
                                        color: '#64748b',
                                        marginTop: '2px',
                                        flexWrap: 'wrap',
                                    }}
                                >
                                    <span>Area Coverage: <strong style={{ color: '#0f172a' }}>{areaPercent}%</strong></span>
                                    <span>Polygons: <strong style={{ color: '#0f172a' }}>{polygonCount}</strong></span>
                                    {zoneData.bbox && (
                                        <span style={{ fontFamily: 'monospace', fontSize: '10px' }}>
                                            BBox: [{zoneData.bbox.join(', ')}]
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

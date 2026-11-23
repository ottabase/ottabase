import { encode } from 'uqr';
import { useMemo } from 'react';

/**
 * A QR code drawn as one SVG path, in the browser: the encoded text (an authenticator app's
 * secret) never leaves the page for an image service. Black on white whatever the theme, because
 * scanners read dark modules on a light ground; the quiet zone is part of the drawing.
 */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
    const { path, modules } = useMemo(() => {
        const { data, size: count } = encode(value, { ecc: 'M', border: 2 });
        let d = '';
        data.forEach((row, y) =>
            row.forEach((dark, x) => {
                if (dark) d += `M${x} ${y}h1v1h-1z`;
            }),
        );
        return { path: d, modules: count };
    }, [value]);

    return (
        <svg
            role="img"
            aria-label={label}
            width={size}
            height={size}
            viewBox={`0 0 ${modules} ${modules}`}
            shapeRendering="crispEdges"
            className="rounded-md ring-1 ring-border"
        >
            <rect width={modules} height={modules} fill="#fff" />
            <path d={path} fill="#000" />
        </svg>
    );
}

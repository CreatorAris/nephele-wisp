/*
 * Asset transfer helper — fetches large binary payloads out-of-band
 * from Nephele's local asset server.
 *
 * Native Messaging caps individual messages at 1 MB. Images and videos
 * blow past that instantly. Per PROTOCOL.md §Large Binary Transfer,
 * Nephele issues a one-time URL token; the extension fetches the
 * binary over HTTP from 127.0.0.1 and verifies the sha256 inline.
 */

/**
 * Fetch and verify an asset from a Nephele-issued token URL.
 *
 * @param {{url: string, sha256?: string, bytes?: number, mime?: string}} asset
 * @returns {Promise<Blob>} the verified blob
 * @throws Error with .code === 'TOKEN_EXPIRED' on HTTP 410, or with
 *   message containing 'sha256 mismatch' / 'size mismatch' on integrity
 *   failure.
 */
export async function fetchAsset(asset) {
    if (!asset || typeof asset.url !== 'string') {
        throw new Error('invalid asset descriptor: missing url');
    }

    let resp;
    try {
        resp = await fetch(asset.url);
    } catch (e) {
        throw new Error(`asset fetch network error: ${e.message}`);
    }

    if (resp.status === 410) {
        const err = new Error(`asset token expired or consumed`);
        err.code = 'TOKEN_EXPIRED';
        throw err;
    }
    if (!resp.ok) {
        throw new Error(`asset fetch failed: HTTP ${resp.status}`);
    }

    const blob = await resp.blob();

    if (typeof asset.bytes === 'number' && blob.size !== asset.bytes) {
        throw new Error(
            `asset size mismatch: got ${blob.size}, expected ${asset.bytes}`,
        );
    }

    if (typeof asset.sha256 === 'string' && asset.sha256) {
        const buf = await blob.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hash = Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        if (hash !== asset.sha256.toLowerCase()) {
            throw new Error(
                `asset sha256 mismatch: got ${hash}, expected ${asset.sha256}`,
            );
        }
    }

    return blob;
}

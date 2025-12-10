import CryptoJS from 'crypto-js';

/**
 * Tencent Cloud COS Signature Algorithm Implementation
 * Reference: https://cloud.tencent.com/document/product/436/7778
 */

export interface CosSignOptions {
    method: string; // HTTP Method: GET, PUT, POST, DELETE, HEAD
    pathname: string; // Object path, e.g., /my-folder/file.txt
    query?: Record<string, string>; // URL query parameters
    headers?: Record<string, string>; // HTTP headers
    secretId: string;
    secretKey: string;
    expires?: number; // Signature validity in seconds, default 3600
}

/**
 * Generate Tencent Cloud COS Authorization Header
 */
export function generateCosAuthorization(options: CosSignOptions): string {
    const {
        method,
        pathname,
        query = {},
        headers = {},
        secretId,
        secretKey,
        expires = 3600,
    } = options;

    // 1. Generate KeyTime and SignTime
    const now = Math.floor(Date.now() / 1000);
    const expiredTime = now + expires;
    const qSignTime = `${now};${expiredTime}`;
    const qKeyTime = qSignTime;

    // 2. Generate SignKey
    const signKey = CryptoJS.HmacSHA1(qKeyTime, secretKey).toString();

    // 3. Build HttpString
    const httpMethod = method.toLowerCase();
    const httpUri = pathname;

    // Build HttpParameters (sorted and encoded)
    // Note: keys must be lowercase, values kept as is but encoded
    const sortedParams = Object.keys(query)
        .sort()
        .map(key => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(query[key])}`)
        .join('&');

    // Build HttpHeaders (sorted and encoded)
    // Note: COS requires header keys to be lowercase
    const sortedHeaders = Object.keys(headers)
        .sort()
        .map(key => `${key.toLowerCase()}=${encodeURIComponent(headers[key])}`)
        .join('&');

    const httpString = `${httpMethod}\n${httpUri}\n${sortedParams}\n${sortedHeaders}\n`;

    // 4. Generate StringToSign
    const httpStringSha1 = CryptoJS.SHA1(httpString).toString();
    const stringToSign = `sha1\n${qSignTime}\n${httpStringSha1}\n`;

    // 5. Generate Signature
    const signature = CryptoJS.HmacSHA1(stringToSign, signKey).toString();

    // 6. Build Authorization
    const signedHeaderList = Object.keys(headers)
        .sort()
        .map(k => k.toLowerCase())
        .join(';');
    const signedParameterList = Object.keys(query)
        .sort()
        .map(k => encodeURIComponent(k).toLowerCase())
        .join(';');

    const authorization = [
        `q-sign-algorithm=sha1`,
        `q-ak=${secretId}`,
        `q-sign-time=${qSignTime}`,
        `q-key-time=${qKeyTime}`,
        `q-header-list=${signedHeaderList}`,
        `q-url-param-list=${signedParameterList}`,
        `q-signature=${signature}`,
    ].join('&');

    return authorization;
}

/**
 * Generate complete request URL
 */
export function buildCosUrl(
    bucket: string,
    region: string,
    pathname: string,
    query?: Record<string, string>
): string {
    // COS URL Format: https://{bucket}.cos.{region}.myqcloud.com{pathname}
    const host = `${bucket}.cos.${region}.myqcloud.com`;
    let url = `https://${host}${pathname}`;

    if (query && Object.keys(query).length > 0) {
        const queryString = Object.keys(query)
            .sort()
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
            .join('&');
        url += `?${queryString}`;
    }

    return url;
}

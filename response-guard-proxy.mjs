import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 39125;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

function isPrivateIpv4(hostname) {
    const parts = hostname.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    return parts[0] === 10
        || parts[0] === 127
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
}

function isLocalOrigin(origin, extraAllowedOrigins) {
    if (!origin) {
        return true;
    }

    if (extraAllowedOrigins.has(origin)) {
        return true;
    }

    try {
        const url = new URL(origin);
        const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? hostname === 'localhost'
                || hostname === '::1'
                || hostname.startsWith('fc')
                || hostname.startsWith('fd')
                || hostname.startsWith('fe80:')
                || isPrivateIpv4(hostname)
            : false;
    } catch (_) {
        return false;
    }
}

function applyCorsHeaders(request, response, extraAllowedOrigins) {
    const origin = request.headers.origin || '';
    if (!isLocalOrigin(origin, extraAllowedOrigins)) {
        return false;
    }

    if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
    }

    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Max-Age', '86400');
    return true;
}

function sendJson(response, statusCode, data) {
    if (response.destroyed || response.writableEnded) {
        return;
    }

    const body = JSON.stringify(data);
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(body);
}

async function readJsonBody(request) {
    const declaredLength = Number(request.headers['content-length'] || 0);
    if (declaredLength > MAX_REQUEST_BYTES) {
        throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 });
    }

    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_REQUEST_BYTES) {
            throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 });
        }
        chunks.push(chunk);
    }

    if (!chunks.length) {
        return {};
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
        throw Object.assign(new Error('请求内容不是有效 JSON。'), { statusCode: 400 });
    }
}

function validateUpstreamUrl(rawUrl, allowHttpUpstream) {
    let url;

    try {
        url = new URL(String(rawUrl || ''));
    } catch (_) {
        throw Object.assign(new Error('上游 API 地址无效。'), { statusCode: 400 });
    }

    if (url.username || url.password) {
        throw Object.assign(new Error('上游 API 地址不能包含用户名或密码。'), { statusCode: 400 });
    }

    if (url.protocol !== 'https:' && !(allowHttpUpstream && url.protocol === 'http:')) {
        throw Object.assign(
            new Error('上游 API 默认必须使用 HTTPS；本地 HTTP 模型需设置 RESPONSE_GUARD_ALLOW_HTTP_UPSTREAM=1。'),
            { statusCode: 400 },
        );
    }

    return url.href;
}

async function forwardUpstream(request, response, route, options) {
    const input = await readJsonBody(request);
    const upstreamUrl = validateUpstreamUrl(input.upstreamUrl, options.allowHttpUpstream);
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, UPSTREAM_TIMEOUT_MS);
    const abortOnDisconnect = () => {
        if (!response.writableEnded) {
            controller.abort();
        }
    };

    request.once('aborted', abortOnDisconnect);
    response.once('close', abortOnDisconnect);

    try {
        const headers = {
            Accept: 'application/json',
            ...(input.apiKey ? { Authorization: `Bearer ${String(input.apiKey).trim()}` } : {}),
        };
        const upstreamOptions = {
            method: route === '/models' ? 'GET' : 'POST',
            headers,
            signal: controller.signal,
        };

        if (route === '/chat/completions') {
            if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
                throw Object.assign(new Error('缺少有效的生成请求内容。'), { statusCode: 400 });
            }

            headers['Content-Type'] = 'application/json';
            upstreamOptions.body = JSON.stringify(input.payload);
        }

        const upstreamResponse = await fetch(upstreamUrl, upstreamOptions);
        const declaredLength = Number(upstreamResponse.headers.get('content-length') || 0);
        if (declaredLength > MAX_RESPONSE_BYTES) {
            throw Object.assign(new Error('上游响应过大。'), { statusCode: 502 });
        }

        const body = Buffer.from(await upstreamResponse.arrayBuffer());
        if (body.length > MAX_RESPONSE_BYTES) {
            throw Object.assign(new Error('上游响应过大。'), { statusCode: 502 });
        }

        if (response.destroyed || response.writableEnded) {
            return;
        }

        response.statusCode = upstreamResponse.status;
        response.statusMessage = upstreamResponse.statusText;
        response.setHeader(
            'Content-Type',
            upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
        );
        response.setHeader('Content-Length', body.length);
        response.end(body);
    } catch (error) {
        if (response.destroyed || response.writableEnded) {
            return;
        }

        if (error?.name === 'AbortError') {
            sendJson(response, timedOut ? 504 : 499, {
                error: { message: timedOut ? '上游 API 请求超时。' : '请求已取消。' },
            });
            return;
        }

        sendJson(response, Number(error?.statusCode) || 502, {
            error: { message: error?.message || '代理请求失败。' },
        });
    } finally {
        clearTimeout(timeoutId);
        request.off('aborted', abortOnDisconnect);
        response.off('close', abortOnDisconnect);
    }
}

export function createResponseGuardProxyServer(options = {}) {
    const extraAllowedOrigins = new Set(
        options.allowedOrigins
        || String(process.env.RESPONSE_GUARD_ALLOWED_ORIGINS || '')
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
    );
    const proxyOptions = {
        allowHttpUpstream: options.allowHttpUpstream
            ?? process.env.RESPONSE_GUARD_ALLOW_HTTP_UPSTREAM === '1',
    };

    return http.createServer((request, response) => {
        if (!applyCorsHeaders(request, response, extraAllowedOrigins)) {
            sendJson(response, 403, { error: { message: '当前网页来源不允许访问此代理。' } });
            return;
        }

        if (request.method === 'OPTIONS') {
            response.statusCode = 204;
            response.end();
            return;
        }

        let pathname;
        try {
            pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
        } catch (_) {
            sendJson(response, 400, { error: { message: '请求路径无效。' } });
            return;
        }

        if (request.method === 'GET' && pathname === '/health') {
            sendJson(response, 200, { ok: true, service: 'response-guard-proxy' });
            return;
        }

        if (request.method === 'POST' && (pathname === '/models' || pathname === '/chat/completions')) {
            void forwardUpstream(request, response, pathname, proxyOptions).catch((error) => {
                sendJson(response, Number(error?.statusCode) || 500, {
                    error: { message: error?.message || '代理请求失败。' },
                });
            });
            return;
        }

        sendJson(response, 404, { error: { message: '代理接口不存在。' } });
    });
}

export async function startResponseGuardProxy(options = {}) {
    const host = options.host || process.env.RESPONSE_GUARD_PROXY_HOST || DEFAULT_HOST;
    const port = Number(options.port || process.env.RESPONSE_GUARD_PROXY_PORT || DEFAULT_PORT);
    const server = createResponseGuardProxyServer(options);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });

    return server;
}

const isMainModule = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
    const server = await startResponseGuardProxy();
    const address = server.address();
    console.log(`[Response Guard] 本地代理已启动：http://${address.address}:${address.port}`);
    console.log('[Response Guard] 请保持此窗口开启；按 Ctrl+C 停止。');

    const closeServer = () => server.close(() => process.exit(0));
    process.once('SIGINT', closeServer);
    process.once('SIGTERM', closeServer);
}

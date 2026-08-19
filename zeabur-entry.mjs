import { startResponseGuardProxy } from './response-guard-proxy.mjs';

const port = Number(
    process.env.PORT
    || process.env.RESPONSE_GUARD_PROXY_PORT
    || 39125
);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`无效的监听端口：${process.env.PORT || process.env.RESPONSE_GUARD_PROXY_PORT}`);
}

const host = '0.0.0.0';

const server = await startResponseGuardProxy({
    host,
    port,
});

const address = server.address();
console.log(`[Response Guard] Zeabur 代理已启动：http://${address.address}:${address.port}`);
console.log('[Response Guard] 请在 Zeabur 设置 RESPONSE_GUARD_ALLOWED_ORIGINS 为你的 SillyTavern 网页 Origin。');

const closeServer = () => {
    server.close(() => process.exit(0));
};

process.once('SIGINT', closeServer);
process.once('SIGTERM', closeServer);

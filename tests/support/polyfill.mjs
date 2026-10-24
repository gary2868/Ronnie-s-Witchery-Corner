// Node 18 沒有全域 crypto；Worker 程式（Cloudflare 環境有全域 crypto）在測試時需要它。
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;

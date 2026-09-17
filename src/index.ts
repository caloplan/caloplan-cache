// Cache：基于 localStorage 的 producer 缓存能力（业务无关）
export { Cache } from "./cache.js";
export type { CacheProducer, StorageLike } from "./cache.js";

// caloplan-cache 单例：createCPCache() 初始化 / getCPCache() 获取
export { createCPCache, getCPCache } from "./cpcache.js";

import { Cache } from "./cache.js";
import type { StorageLike } from "./cache.js";

let instance: Cache | null = null;

/**
 * 初始化 caloplan-cache 单例（与 createCPCore / createCPUser 的依赖注册方式保持一致）。
 * - storage: 可选，默认使用 window.localStorage；测试或非浏览器环境可注入自定义实现
 */
export function createCPCache(storage?: StorageLike): Cache {
  instance = new Cache(storage);
  return instance;
}

/** 获取 caloplan-cache 单例：cache.register / cache.get / cache.refresh / cache.delete */
export function getCPCache(): Cache {
  if (instance == null) {
    throw new Error("CPCache 未初始化：请先调用 createCPCache()");
  }
  return instance;
}

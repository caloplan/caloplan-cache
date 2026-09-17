/**
 * caloplan-cache — 基于 localStorage 的 producer 缓存能力（业务无关）。
 *
 * 核心思想：
 * - register 提供数据生产方式（producer）
 * - get 优先使用缓存，未命中时调用 producer 并回写
 * - refresh 强制重新生产并覆盖缓存
 * - delete 清除缓存（不删除 producer 注册）
 *
 * producers 与 localStorage 缓存彼此独立：producer 只保存在内存 Map 中，
 * localStorage 只保存 JSON 序列化后的实际数据，两者不会互相影响。
 */

/** 最小存储契约：结构兼容 window.localStorage，便于测试注入 mock */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 数据生产者：可同步返回，也可异步返回 */
export type CacheProducer<T> = () => Promise<T> | T;

/** 默认存储：浏览器 window.localStorage（仅当未注入自定义 storage 时使用） */
function resolveDefaultStorage(): StorageLike {
  if (typeof window === "undefined" || window.localStorage == null) {
    throw new Error(
      "Cache 初始化失败：当前环境没有可用的 localStorage（请传入自定义 storage，或运行在浏览器环境）",
    );
  }
  return window.localStorage;
}

/** 包装错误：保留原始异常（message + cause），并补充明确上下文 */
function withContext(context: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`${context}：${detail}`, { cause: err });
}

export class Cache {
  /** producer 注册表：只保存在内存，不序列化到 localStorage */
  private readonly producers = new Map<string, CacheProducer<unknown>>();

  private readonly storage: StorageLike;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? resolveDefaultStorage();
  }

  /** 注册数据生产者。不会立即调用 producer，也不会立即写入 localStorage。 */
  register<T>(key: string, producer: CacheProducer<T>): void {
    this.producers.set(key, producer);
  }

  /**
   * 读取缓存：
   * - localStorage 命中 → 直接 JSON.parse 返回
   * - 未命中 → 调用 producer 生产，JSON.stringify 写入后返回
   * - 未命中且未注册 producer → 抛明确错误（不静默返回 undefined）
   */
  async get<T>(key: string): Promise<T | null> {
    const cached = this.read(key);
    if (cached != null) {
      return this.parse<T>(key, cached);
    }

    const producer = this.producers.get(key);
    if (producer == null) {
      throw new Error(
        `Cache.get 失败：key = "${key}" 未注册 producer，且 localStorage 无缓存`,
      );
    }

    return (await this.produceAndStore(key, producer)) as T | null;
  }

  /**
   * 强制刷新：无视现有缓存，调用 producer 获取最新数据并覆盖缓存。
   * 未注册 producer 时抛明确错误。
   */
  async refresh<T>(key: string): Promise<T> {
    const producer = this.producers.get(key);
    if (producer == null) {
      throw new Error(`Cache.refresh 失败：key = "${key}" 未注册 producer`);
    }

    return (await this.produceAndStore(key, producer)) as T;
  }

  /** 删除 localStorage 缓存数据；producer 注册保留，后续 get 会重新生产。 */
  delete(key: string): void {
    this.remove(key);
  }

  /** 生产 → 序列化 → 写入；任一步失败都抛带上下文的明确错误，且不写入错误数据 */
  private async produceAndStore(
    key: string,
    producer: CacheProducer<unknown>,
  ): Promise<unknown> {
    let value: unknown;
    try {
      value = await producer();
    } catch (err) {
      throw withContext(`Cache 数据生产失败：key = "${key}"`, err);
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (err) {
      throw withContext(
        `Cache 序列化失败：key = "${key}" 的数据无法 JSON.stringify`,
        err,
      );
    }

    this.write(key, serialized);
    return value;
  }

  private parse<T>(key: string, raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw withContext(
        `Cache 解析失败：key = "${key}" 的缓存不是合法 JSON`,
        err,
      );
    }
  }

  /** localStorage 访问集中点：读取 */
  private read(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch (err) {
      throw withContext(`Cache 读取失败：key = "${key}"`, err);
    }
  }

  /** localStorage 访问集中点：写入 */
  private write(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch (err) {
      throw withContext(`Cache 写入失败：key = "${key}"`, err);
    }
  }

  /** localStorage 访问集中点：删除 */
  private remove(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch (err) {
      throw withContext(`Cache 删除失败：key = "${key}"`, err);
    }
  }
}

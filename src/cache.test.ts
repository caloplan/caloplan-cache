import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Cache } from "./cache.js";
import type { StorageLike } from "./cache.js";
import { createCPCache, getCPCache } from "./cpcache.js";

/** 内存版 localStorage stub：记录数据，支持注入初始值，便于断言读写行为 */
function makeStorage(initial: Record<string, string> = {}): {
  storage: StorageLike;
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { storage, data };
}

describe("Cache.register", () => {
  test("producer 可以正常注册，且注册时不立即调用", () => {
    const { storage } = makeStorage();
    const cache = new Cache(storage);
    let calls = 0;
    cache.register("user", () => {
      calls += 1;
      return { id: 1 };
    });
    assert.equal(calls, 0);
  });
});

describe("Cache.get", () => {
  test("缓存命中时直接读取 localStorage，不调用 producer", async () => {
    const { storage } = makeStorage({ user: '{"id":1,"name":"alice"}' });
    const cache = new Cache(storage);
    let calls = 0;
    cache.register("user", () => {
      calls += 1;
      return { id: 2 };
    });

    const value = await cache.get<{ id: number; name?: string }>("user");

    assert.deepEqual(value, { id: 1, name: "alice" });
    assert.equal(calls, 0);
  });

  test("缓存未命中时调用 producer，结果 JSON.stringify 后写入 localStorage", async () => {
    const { storage, data } = makeStorage();
    const cache = new Cache(storage);
    let calls = 0;
    cache.register("user", () => {
      calls += 1;
      return { id: 2 };
    });

    const value = await cache.get<{ id: number }>("user");

    assert.deepEqual(value, { id: 2 });
    assert.equal(calls, 1);
    assert.equal(data.get("user"), '{"id":2}');
  });

  test("缓存写入后再次 get 不再调用 producer", async () => {
    const { storage } = makeStorage();
    const cache = new Cache(storage);
    let calls = 0;
    cache.register("user", () => {
      calls += 1;
      return { id: 1 };
    });

    const first = await cache.get<{ id: number }>("user");
    const second = await cache.get<{ id: number }>("user");

    assert.deepEqual(first, { id: 1 });
    assert.deepEqual(second, { id: 1 });
    assert.equal(calls, 1);
  });

  test("未注册 producer 且无缓存时抛明确错误", async () => {
    const { storage } = makeStorage();
    const cache = new Cache(storage);

    await assert.rejects(() => cache.get("ghost"), /未注册 producer/);
  });
});

describe("Cache.refresh", () => {
  test("即使 localStorage 已有缓存也调用 producer，新结果覆盖旧缓存", async () => {
    const { storage, data } = makeStorage({ user: '{"id":1}' });
    const cache = new Cache(storage);
    let calls = 0;
    cache.register("user", () => {
      calls += 1;
      return { id: 2, name: "new" };
    });

    const value = await cache.refresh<{ id: number; name?: string }>("user");

    assert.deepEqual(value, { id: 2, name: "new" });
    assert.equal(calls, 1);
    assert.equal(data.get("user"), '{"id":2,"name":"new"}');
  });

  test("未注册 producer 时抛明确错误", async () => {
    const { storage } = makeStorage({ user: '{"id":1}' });
    const cache = new Cache(storage);

    await assert.rejects(() => cache.refresh("user"), /未注册 producer/);
  });
});

describe("Cache.delete", () => {
  test("删除 localStorage 缓存数据，但保留 producer 注册", async () => {
    const { storage, data } = makeStorage();
    const cache = new Cache(storage);
    cache.register("user", () => ({ id: 1 }));
    await cache.get("user");
    assert.equal(data.has("user"), true);

    cache.delete("user");

    assert.equal(data.has("user"), false);
    // producer 注册仍在：再次 get 能重新生产数据
    const value = await cache.get<{ id: number }>("user");
    assert.deepEqual(value, { id: 1 });
    assert.equal(data.has("user"), true);
  });

  test("delete 后再次 get 会重新调用 producer", async () => {
    const { storage } = makeStorage();
    const cache = new Cache(storage);
    let id = 1;
    cache.register("user", () => ({ id: id++ }));

    await cache.get("user");
    cache.delete("user");
    const value = await cache.get<{ id: number }>("user");

    assert.deepEqual(value, { id: 2 });
  });
});

describe("Cache 异常处理", () => {
  test("producer 同步抛异常时抛明确错误，且不写入错误数据", async () => {
    const { storage, data } = makeStorage();
    const cache = new Cache(storage);
    cache.register("user", () => {
      throw new Error("backend down");
    });

    await assert.rejects(
      () => cache.get("user"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /数据生产失败/);
        assert.match(err.message, /backend down/);
        return true;
      },
    );
    assert.equal(data.has("user"), false);
  });

  test("producer 异步 reject 时抛明确错误，且不写入错误数据", async () => {
    const { storage, data } = makeStorage();
    const cache = new Cache(storage);
    cache.register("user", async () => {
      throw new Error("network error");
    });

    await assert.rejects(
      () => cache.refresh("user"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /数据生产失败/);
        assert.match(err.message, /network error/);
        return true;
      },
    );
    assert.equal(data.has("user"), false);
  });

  test("JSON.parse 失败时抛明确错误", async () => {
    const { storage } = makeStorage({ bad: "not-json{" });
    const cache = new Cache(storage);

    await assert.rejects(
      () => cache.get("bad"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /解析失败/);
        assert.match(err.message, /不是合法 JSON/);
        return true;
      },
    );
  });

  test("JSON.stringify 失败时抛明确错误，且不写入错误数据", async () => {
    const { storage, data } = makeStorage();
    const cache = new Cache(storage);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    cache.register("circular", () => circular);

    await assert.rejects(
      () => cache.refresh("circular"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /序列化失败/);
        assert.match(err.message, /JSON.stringify/);
        return true;
      },
    );
    assert.equal(data.has("circular"), false);
  });

  test("localStorage 不可用时抛明确错误", async () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("storage denied");
      },
      setItem: () => {
        throw new Error("storage denied");
      },
      removeItem: () => {
        throw new Error("storage denied");
      },
    };
    const cache = new Cache(broken);

    await assert.rejects(
      () => cache.get("user"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /读取失败/);
        assert.match(err.message, /storage denied/);
        return true;
      },
    );
  });
});

describe("单例 createCPCache / getCPCache", () => {
  test("未初始化时 getCPCache 抛明确错误", () => {
    assert.throws(() => getCPCache(), /未初始化/);
  });

  test("createCPCache 返回 Cache 实例，getCPCache 返回同一实例", () => {
    const { storage } = makeStorage();
    const created = createCPCache(storage);

    assert.ok(created instanceof Cache);
    assert.equal(getCPCache(), created);
    // 实例包含全部入口
    assert.equal(typeof created.register, "function");
    assert.equal(typeof created.get, "function");
    assert.equal(typeof created.refresh, "function");
    assert.equal(typeof created.delete, "function");
  });
});

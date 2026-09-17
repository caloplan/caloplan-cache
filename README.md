# caloplan-cache

CaloPlan 的 middleware / 基础能力层 — 基于 `localStorage` 的 producer 缓存能力，**业务无关**。

它不感知 CaloPlan 的任何业务实体（User / Food / Meal / Nutrition 等），只做一件事：
**register 提供数据生产方式，get 优先使用缓存，refresh 强制重新生产，delete 清除缓存。**
## 相关项目（CaloPlan 全家桶）

CaloPlan 全栈项目统一托管在 GitHub Organization [caloplan](https://github.com/caloplan)：

| 类型 | 项目 | 与本项目关系 |
| --- | --- | --- |
| 前端 | [coloplan-v2](https://github.com/caloplan/coloplan-v2) | 上层客户端：消费本模块的缓存能力 |
| SDK | [caloplan-core](https://github.com/caloplan/caloplan-core) | 餐食 / 食物模块（缓存经本模块注入） |
| SDK | [caloplan-user](https://github.com/caloplan/caloplan-user) | 用户模块（Token 持久化等） |
| SDK | [caloplan-chat](https://github.com/caloplan/caloplan-chat) | AI 对话模块（本地聊天历史经本模块缓存） |
| SDK（本仓库） | [caloplan-cache](https://github.com/caloplan/caloplan-cache) | 通用缓存基础能力（业务无关） |
| 服务 | [fastapi-chat-service](https://github.com/caloplan/fastapi-chat-service) | AI 对话后端 |
| 服务 | [fastapi-file-service](https://github.com/caloplan/fastapi-file-service) | 图片上传后端 |
| 服务 | [mservice-fastapi-user](https://github.com/caloplan/mservice-fastapi-user) | 认证 / 用户微服务 |
| 服务 | [mservice-fastapi-metastorage](https://github.com/caloplan/mservice-fastapi-metastorage) | 元数据微服务 |

本模块为业务无关的通用基础层：不感知任何业务实体，被 `caloplan-chat` / `coloplan-v2` 等上层复用。

## 核心思想

```
register 提供数据生产方式（producer）
get      优先使用缓存，未命中时调用 producer 并回写
refresh  强制重新生产并覆盖缓存
delete   清除缓存（不删除 producer 注册）
```

```
Cache
├── producers: Map<string, Producer>   ← 只保存在内存，不序列化
└── localStorage                       ← 只保存 JSON 序列化后的实际数据
    ├── key A → data
    ├── key B → data
    └── key C → data
```

**producer 注册表 ≠ localStorage 缓存，两者完全独立：**

```typescript
cache.register("user", producer);
cache.delete("user");        // 只删 localStorage 缓存
cache.get("user");           // producer 注册仍在 → 重新调用 producer 生成数据
```

## 设计原则

1. **业务无关**：不引入 User / Food / Meal / Nutrition 等业务类型，缓存本身是通用基础能力
2. **简单直接**：无 TTL / LRU / Strategy / Repository / Entity / Factory 等复杂抽象
3. **不重复实现**：不创建 UserSDK / MetaSDK，不引入 DI Framework，只做缓存自己该做的事
4. **producer 与缓存分离**：注册信息只在内存，缓存数据只在 localStorage
5. **错误明确**：所有失败都保留原始异常信息并补充上下文，不做复杂 fallback
6. **不过度设计**：第一版直接使用 `window.localStorage`，不为未来 Redis / IndexedDB 提前抽象

## 安装

```bash
pnpm add caloplan-cache
```

## 快速开始

```typescript
import { createCPCache, getCPCache } from "caloplan-cache";

// 应用启动时初始化单例（默认使用 window.localStorage）
createCPCache();

// 获取使用
const cache = getCPCache();

// 注册数据生产者：不立即调用，不立即写入
cache.register("current-user", () => userSdk.getCurrentUser());

// 读取：优先缓存，未命中时自动调用 producer 并回写
const user = await cache.get("current-user");

// 刷新：无视缓存，强制调用 producer 获取最新数据并覆盖
const latestUser = await cache.refresh("current-user");

// 删除：清除 localStorage 缓存，保留 producer 注册
cache.delete("current-user");
```

## API

### register

```typescript
register<T>(key: string, producer: () => Promise<T> | T): void
```

注册一个 key 对应的数据生产者。

- **不立即调用** producer
- **不立即写入** localStorage
- 只把 `key → producer` 存入内存 Map
- 重复注册同一 key 会覆盖旧 producer

```typescript
cache.register("current-user", () => userSdk.getCurrentUser());
cache.register("meal-list", async () => (await mealRepo.listMine()).items);
```

### get

```typescript
get<T>(key: string): Promise<T | null>
```

读取缓存数据。

| 场景 | 行为 |
| --- | --- |
| localStorage 命中 | 直接 `JSON.parse` 返回缓存数据，**不调用 producer** |
| 未命中但有 producer | 调用 producer 获取数据，`JSON.stringify` 写入 localStorage 后返回 |
| 未命中且无 producer | **抛明确错误**（不静默返回 `undefined` / `null`） |

```
get(key)
│
├── localStorage 有数据
│       ↓
│     JSON.parse
│       ↓
│     return 缓存数据
│
└── 没有数据
        ↓
      producer()
        ↓
      JSON.stringify + localStorage.setItem
        ↓
      return 最新数据
```

```typescript
// 命中缓存：直接返回，不触发 producer
const user = await cache.get<User>("current-user");

// 未注册 producer 且无缓存：抛错
await cache.get("unknown-key");
// Error: Cache.get 失败：key = "unknown-key" 未注册 producer，且 localStorage 无缓存
```

### refresh

```typescript
refresh<T>(key: string): Promise<T>
```

强制刷新缓存。

- **无视当前 localStorage 是否存在缓存**，必然调用 producer
- producer 的新结果覆盖旧缓存
- 返回最新数据
- 未注册 producer 时抛明确错误

```
refresh(key)
    ↓
  producer()
    ↓
  JSON.stringify
    ↓
  localStorage.setItem
    ↓
  return 最新数据
```

```typescript
const latestUser = await cache.refresh<User>("current-user");
```

### delete

```typescript
delete(key: string): void
```

删除 localStorage 中对应的缓存数据。

- **不删除** register 保存的 producer
- delete 之后再次 get 会重新调用 producer 生成数据

```typescript
cache.register("user", producer);
cache.delete("user");

// producer 注册仍在 → get 会重新调用 producer
await cache.get("user");
```

## 类型设计

```typescript
type CacheProducer<T> = () => Promise<T> | T;
```

API 全程泛型，显式传入业务类型即可获得类型推导，且不引入任何业务实体类型：

```typescript
interface CurrentUser {
  user_id: number;
  username: string;
}

cache.register<CurrentUser>("current-user", () => userSdk.getCurrentUser());
const user = await cache.get<CurrentUser>("current-user");  // CurrentUser | null
```

## 序列化

localStorage 只保存 JSON：

- 写入：`JSON.stringify(value)`
- 读取：`JSON.parse(value)`

**错误处理**（保留原始异常信息 + 明确上下文，不做复杂 fallback）：

| 失败场景 | 抛出的错误 |
| --- | --- |
| producer 抛异常（同步 throw 或异步 reject） | `Cache 数据生产失败：key = "xxx"：<原始错误>`，且**不写入任何数据** |
| `JSON.stringify` 失败（如循环引用） | `Cache 序列化失败：key = "xxx" 的数据无法 JSON.stringify：<原始错误>`，且**不写入任何数据** |
| `JSON.parse` 失败（缓存数据损坏） | `Cache 解析失败：key = "xxx" 的缓存不是合法 JSON：<原始错误>` |
| localStorage 不可用（访问抛错） | `Cache 读取/写入/删除失败：key = "xxx"：<原始错误>` |
| 未注册 producer | `Cache.get 失败：... 未注册 producer` / `Cache.refresh 失败：... 未注册 producer` |

所有包装错误都会：
- 在 message 中保留**原始错误信息**（`err.message`）
- 通过 `cause` 保留**原始异常对象**

## 单例

与 CaloPlan 其他模块的依赖注册方式一致（`createCPCore` / `createCPUser`）：

```typescript
import { createCPCache, getCPCache } from "caloplan-cache";

// 应用启动时初始化一次
createCPCache();

// 或注入自定义 storage（测试 / 非浏览器环境）
createCPCache(mockStorage);

// 获取同一实例
const cache = getCPCache();
```

- **未初始化**时调用 `getCPCache()` 抛明确错误：`CPCache 未初始化：请先调用 createCPCache()`
- 也可以直接 `new Cache(storage?)` 构造实例（不经过单例）

## Storage 抽象

第一版默认直接使用 `window.localStorage`，**不预演** Redis / SessionStorage / IndexedDB 等未来场景。

localStorage 的访问集中在内部三个方法，便于测试注入 mock：

```typescript
interface StorageLike {
  getItem(key: string): string | null;   // read
  setItem(key: string, value: string): void; // write
  removeItem(key: string): void;         // remove
}
```

- 浏览器环境：不传 storage 时自动使用 `window.localStorage`
- 非浏览器环境（Node 测试）：`new Cache(mockStorage)` 注入内存实现
- 未注入且环境无 `localStorage`：构造时抛明确错误

## 明确不实现的内容

当前版本**刻意不实现**（出现真实需求再设计）：

| 不实现 | 原因 |
| --- | --- |
| TTL / 自动过期 | 未出现需求 |
| LRU | 未出现需求 |
| Cache Strategy / Repository / Entity | 避免复杂抽象 |
| 后台刷新 / SWR | 未出现需求 |
| Redis / IndexedDB / 多级缓存 / 网络缓存 | 第一版只支持 localStorage |
| 业务相关 cache key / User / Food / Meal 专用 API | 本库业务无关 |
| 复杂 DI / Event Bus / Observable / 状态管理 | 保持简单 |

## 典型使用场景

### 场景 1：缓存当前用户信息

```typescript
cache.register("current-user", () => userSdk.getCurrentUser());

// 首次调用：请求后端并写入缓存
const user = await cache.get("current-user");

// 后续调用：直接读缓存，不发请求
const cached = await cache.get("current-user");
```

### 场景 2：用户资料更新后强制刷新

```typescript
await userSdk.updateProfile({ nickname: "新昵称" });

// 覆盖旧缓存，下次 get 读到新数据
await cache.refresh("current-user");
```

### 场景 3：登出时清除缓存（保留注册）

```typescript
function logout() {
  cache.delete("current-user");
  cache.delete("meal-list");
  // producer 注册仍在：下次登录后 get 会自动重新生产
}
```

## 开发

```bash
pnpm install
pnpm typecheck   # TypeScript 类型检查
pnpm test        # 运行全部测试（16 个用例）
pnpm build       # 构建到 dist/
```

### 测试覆盖

| 分组 | 覆盖点 |
| --- | --- |
| register | producer 正常注册；注册不立即调用 |
| get | 命中缓存不调用 producer；未命中调用 producer 并写入；后续 get 不再调用 producer；未注册 producer 抛错 |
| refresh | 有缓存也调用 producer；新结果覆盖旧缓存；未注册 producer 抛错 |
| delete | 删除缓存数据；保留 producer 注册；delete 后 get 重新调用 producer |
| 异常 | producer 同步抛错 / 异步 reject 不写入错误数据；JSON.parse 失败明确报错；JSON.stringify 失败明确报错；localStorage 不可用明确报错 |
| 单例 | 未初始化抛错；create 返回实例、get 返回同一实例、包含全部入口 |

## 文件结构

```
caloplan-cache
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── .gitignore
└── src/
    ├── cache.ts         # Cache 类 + CacheProducer / StorageLike 类型（核心）
    ├── cpcache.ts       # 单例 createCPCache / getCPCache
    ├── index.ts         # 包入口，按段聚合导出
    └── cache.test.ts    # 16 个测试用例
```

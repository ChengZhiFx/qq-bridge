// QQ 系统表情（经典小黄脸等）目录与解析。
//
// 设计原则：**不做静态硬编码表**。QQ NT 客户端的系统表情编号与老 CoolQ 时代的
// 对照表并不一致（实测：NTQQ 目录里 14=微笑、178=斜眼笑、179=doge，而老表里
// 1=微笑），而且目录会随版本增删（当前 398 个、10 个分组）。权威来源只有
// SnowLuma 运行时的 `fetch_sys_faces` 动作（HTTP POST），所以这里做的是：
//   1) 拉一次目录并构建 id→条目 / 名称→条目 的索引，带 TTL 缓存；
//   2) 接收侧展示（[表情:名称]）用同步查缓存，缓存未就绪时回退 [表情N]；
//   3) 发送侧按「编号或名称」解析，重名时优先非超级表情（静态小黄脸）；
//   4) 本地搜索支持口语别名（如「狗头」→ doge），因为目录里没有这些俗名。
//
// 超级表情（is_super=true，如 452=微笑的动画版）用 face 段发送的兼容性未验证，
// 名称解析时一律避开；显式传编号仍允许（模型自己承担显示效果）。
// 「emoji 表情」分组的 q_sid 是 Unicode 字符（😊），不能当 face id 发送，直接过滤。

const CATALOG_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const MAX_SEARCH_RESULTS = 30;

// 口语俗名 → 目录内官方名称，**只收目录里查不到的俗名**。
// 值可以是数组：表示这个俗名在不同人群里指**不同表情**（实测踩坑：「狗头」
// 一部分人指 doge(179) 柴犬梗图，另一部分人指 汪汪(277)—— 是两只不同的狗）。
// 多候选时不替用户拍板：解析返回候选清单，搜索两个都给，让 AI 按语境挑。
const FACE_ALIASES = Object.freeze({
  狗头: ['doge', '汪汪'],
});

/** 俗名 → 候选官方名列表（无别名返回空数组）。 */
function aliasTargetsFor(raw) {
  const value = FACE_ALIASES[raw] ?? FACE_ALIASES[String(raw ?? '').toLowerCase()];
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

let cache = null; // { byId: Map, byName: Map, names: string[], loadedAt: number }
let inflight = null;

function normalizeName(des) {
  return String(des ?? '').replace(/^\//, '').trim();
}

function isNumericFaceId(id) {
  return /^(?:0|[1-9]\d{0,3})$/.test(String(id ?? ''));
}

function oneBotFaceUrl(httpUrl) {
  return `${String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')}/fetch_sys_faces`;
}

async function postJson(url, body, accessToken, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs ?? 20000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== 'ok' || json.retcode !== 0) {
    throw new Error(`fetch_sys_faces 失败: ${json.wording || json.retcode || res.status}`);
  }
  return json.data;
}

function buildIndex(packs) {
  const byId = new Map();
  const byName = new Map();
  const put = (entry) => {
    const id = String(entry.q_sid ?? '');
    if (!isNumericFaceId(id)) return; // emoji 分组的 q_sid 是 Unicode 字符，不能按 face id 发
    const item = {
      id,
      name: normalizeName(entry.q_des),
      pack: entry.packName || '',
      isSuper: entry.is_super === true,
      url: entry.url || null
    };
    if (!byId.has(id)) byId.set(id, item);
    if (item.name) {
      const list = byName.get(item.name) || [];
      list.push(item);
      byName.set(item.name, list);
    }
  };
  for (const pack of packs ?? []) {
    for (const face of pack.emojis ?? []) put({ ...face, packName: pack.pack_name });
  }
  return { byId, byName, names: [...byName.keys()], loadedAt: Date.now() };
}

/**
 * 拉取（或复用缓存的）QQ 系统表情目录。
 * @returns {Promise<{byId:Map,byName:Map,names:string[],loadedAt:number}|null>}
 *          SnowLuma 不可用时返回 null（调用方按「目录未就绪」处理，不要抛错阻塞主流程）。
 */
export async function loadSysFaceCatalog({ httpUrl, accessToken, force = false, timeoutMs } = {}) {
  if (!force && cache && Date.now() - cache.loadedAt < CATALOG_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await postJson(oneBotFaceUrl(httpUrl), {}, accessToken, timeoutMs);
      const next = buildIndex(data?.packs);
      cache = next;
      return next;
    } catch {
      // 目录拉不到（SnowLuma 离线 / 老版本没有该动作）：保留旧缓存可用性。
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 目录是否已就绪（接收侧展示用）。 */
export function sysFaceCatalogReady() {
  return Boolean(cache && cache.byId.size > 0);
}

/** 同步按编号查名称；未就绪或未知编号返回 null。 */
export function faceNameFor(id) {
  if (!cache) return null;
  const entry = cache.byId.get(String(id ?? ''));
  return entry ? entry.name : null;
}

/**
 * 解析「编号或名称」为可发送的 face 条目。
 * 名称匹配：先查口语别名，再精确匹配目录名，最后取唯一的前缀/包含匹配。
 * 重名时优先非超级表情（静态小黄脸），保证发送效果可预期。
 * @returns {{id:string,name:string,isSuper:boolean,pack:string}|{candidates:Array}|null}
 *          返回 {candidates} 表示名称有歧义（多个不同名称都包含该词）。
 */
export function resolveFaceRef(ref) {
  if (!cache) return null;
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  if (isNumericFaceId(raw)) {
    const entry = cache.byId.get(raw);
    // 数字形态先按编号查；查不到不能直接判失败 —— 「666」这样的名字本身像数字
    //（实际编号 356），必须继续走名称匹配。
    if (entry) return { ...entry };
  }
  const aliasTargets = aliasTargetsFor(raw);
  const pick = (list) => {
    if (!list || !list.length) return null;
    const plain = list.find((e) => !e.isSuper);
    return { ...(plain || list[0]) };
  };
  // 俗名多候选（如「狗头」= doge / 汪汪）：先看是否有精确同名的目录条目，
  // 没有就把所有候选解析出来 —— 恰好一个就用，多个就交出候选清单。
  if (aliasTargets.length && !cache.byName.get(raw)) {
    const aliasResolved = aliasTargets
      .map((t) => pick(cache.byName.get(t)))
      .filter(Boolean);
    const distinct = [...new Map(aliasResolved.map((e) => [e.id, e])).values()];
    if (distinct.length === 1) return distinct[0];
    if (distinct.length > 1) {
      return { candidates: distinct.map(({ id, name, pack, isSuper }) => ({ id, name, pack, isSuper })) };
    }
  }
  const exact = pick(cache.byName.get(raw));
  if (exact) return exact;
  // 大小写不敏感的精确匹配（ok→OK、no→NO）：名称表里大小写混用，模型输入不一定带对。
  {
    const lower = raw.toLowerCase();
    const ciNames = [
      cache.names.find((n) => n.toLowerCase() === lower),
      ...aliasTargets.map((t) => cache.names.find((n) => n.toLowerCase() === t.toLowerCase()))
    ].filter(Boolean);
    for (const ciName of ciNames) {
      const ci = pick(cache.byName.get(ciName));
      if (ci) return ci;
    }
  }
  // 模糊匹配：唯一命中（按名称去重）就直接用；多个不同名称命中则交出候选清单。
  const hits = new Map();
  const needles = [raw, ...aliasTargets];
  for (const name of cache.names) {
    if (needles.some((needle) => name.includes(needle))) {
      const chosen = pick(cache.byName.get(name));
      if (chosen) hits.set(chosen.id, { ...chosen });
    }
  }
  const values = [...hits.values()];
  if (values.length === 1) return values[0];
  if (values.length > 1) {
    return { candidates: values.slice(0, MAX_SEARCH_RESULTS).map(({ id, name, pack, isSuper }) => ({ id, name, pack, isSuper })) };
  }
  return null;
}

/** 本地搜索（供 qq_search_faces / 名称解析失败提示用）。 */
export function searchSysFacesLocal(query, limit = MAX_SEARCH_RESULTS) {
  if (!cache) return [];
  const q = String(query ?? '').trim();
  if (!q) return [];
  const aliasTargets = aliasTargetsFor(q);
  const results = [];
  const seen = new Set();
  const consider = (entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    results.push({ id: entry.id, name: entry.name, pack: entry.pack, isSuper: entry.isSuper });
  };
  if (isNumericFaceId(q)) {
    const entry = cache.byId.get(q);
    if (entry) consider(entry);
  }
  for (const target of aliasTargets) {
    for (const e of cache.byName.get(target) || []) consider(e);
  }
  for (const name of cache.names) {
    if (name.includes(q)) for (const e of cache.byName.get(name)) consider(e);
  }
  // 非超级的排前面（静态小黄脸最常用），再按编号数值排序，结果稳定可复现。
  results.sort((a, b) => Number(a.isSuper) - Number(b.isSuper) || Number(a.id) - Number(b.id));
  return results.slice(0, Math.max(1, limit));
}

/** 目录统计（诊断 / 提示语用）。 */
export function sysFaceCatalogStats() {
  if (!cache) return { ready: false, total: 0 };
  return { ready: true, total: cache.byId.size };
}

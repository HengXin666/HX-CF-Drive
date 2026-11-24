// CF 免费额度占用估算 (v0.2, 只用 TG, 不用 R2 和 DO)。用法: node scripts/quota.mjs [参数=值 ...]
// 每次操作的 D1 行数来自本地实测 (scripts/meter.mjs, D1_METER=1), 不是拍脑袋
const arg = Object.fromEntries(process.argv.slice(2).map((s) => s.split('=')).map(([k, v]) => [k, Number(v)]));
const P = {
  downGB: 100, // 每日下载量
  upGB: 10, // 每日上传量
  videoShare: 0.6, // 视频占字节比例
  imgMB: 8, // 图片平均大小
  vidMB: 200, // 视频平均大小
  rangeMB: 16, // 播放器单次响应平均大小 (保守, 实际常更大)
  chunkMB: 19, // 分片大小
  hit: 0.5, // 读取时 isolate 内存缓存命中率 (保守)
  apiCalls: 1000, // 每日列目录, stat, 移动等其他调用
  listSize: 50, // 列目录平均子项数
  searches: 50, // 每日搜索次数 (默认每令牌每分钟最多 6 次)
  nodes: 50000, // 节点总数, 搜索未命中时全表扫描
  ...arg,
};
const GB = 1024;

// 实测每次操作的行读 r / 行写 w (见 docs/QUOTA.md 第 2 节)
const OP = {
  imgUpload: { r: 6, w: 8 }, // 一次性上传, 含新建目录
  init: { r: 5, w: 3 },
  commit: { r: 0, w: 6 },
  readCold: { r: 2, w: 0 },
  readWarm: { r: 0, w: 0 }, // /f 签名直链命中内存缓存
  rangeWarm: { r: 1, w: 0 }, // /api/v1/files/:id/content 命中清单缓存
  list: { r: 2 * P.listSize + 10, w: 0 },
};

const imgDown = (P.downGB * (1 - P.videoShare) * GB) / P.imgMB;
const vidReq = (P.downGB * P.videoShare * GB) / P.rangeMB;
const imgUp = (P.upGB * (1 - P.videoShare) * GB) / P.imgMB;
const vidUp = (P.upGB * P.videoShare * GB) / P.vidMB;
const vidChunks = vidUp * Math.ceil(P.vidMB / P.chunkMB);

const workers = imgDown + vidReq + imgUp + vidUp * 2 + vidChunks + P.apiCalls + P.searches + 1;
const read = (n, warm, cold) => n * (P.hit * warm.r + (1 - P.hit) * cold.r);
const d1Read =
  read(imgDown, OP.readWarm, OP.readCold) + read(vidReq, OP.rangeWarm, OP.readCold) +
  imgUp * OP.imgUpload.r + vidUp * OP.init.r + P.apiCalls * OP.list.r + P.searches * P.nodes;
const d1Write = imgUp * OP.imgUpload.w + vidUp * (OP.init.w + OP.commit.w);
const tgMsgs = imgUp + vidChunks;

const rows = [
  ['Workers 请求/日', workers, 100000],
  ['D1 读行/日 (含搜索最坏情况)', d1Read, 5000000],
  ['D1 读行/日 (不含搜索)', d1Read - P.searches * P.nodes, 5000000],
  ['D1 写行/日', d1Write, 100000],
  ['TG 消息/日 (单频道约 15/分)', tgMsgs, 15 * 60 * 24],
  ['R2 / DO', 0, 1],
];
console.log('参数', JSON.stringify(P));
console.log('项目'.padEnd(30), '用量'.padStart(12), '免费额度'.padStart(12), '占用'.padStart(8));
for (const [name, used, cap] of rows) {
  const pct = cap > 1 ? ((used / cap) * 100).toFixed(1) + '%' : '0';
  console.log(name.padEnd(30), Math.round(used).toLocaleString().padStart(12), (cap > 1 ? cap.toLocaleString() : '-').padStart(12), pct.padStart(8));
}

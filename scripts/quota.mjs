// CF 免费额度占用估算。用法: node scripts/quota.mjs [参数=值 ...]
// 例: node scripts/quota.mjs downGB=100 upGB=10 videoShare=0.6 r2Public=1
const arg = Object.fromEntries(process.argv.slice(2).map((s) => s.split('=')).map(([k, v]) => [k, Number(v)]));
const P = {
  downGB: 100, // 每日下载量
  upGB: 10, // 每日上传量
  videoShare: 0.6, // 视频占字节比例 (上传与下载相同)
  imgMB: 8, // 图片平均大小
  vidMB: 200, // 视频平均大小
  rangeMB: 16, // 播放器单次 Range 平均大小
  chunkMB: 16, // 分片大小
  apiCalls: 1000, // 每日列目录/搜索外的其他 API 调用
  searches: 50, // 每日搜索次数
  nodes: 50000, // 文件总数 (影响搜索扫描行数)
  r2Public: 1, // 1 = R2 视频走公开域名, 不经 Worker
  videoTo: 'r2',
  ...arg,
};
const vidTo = process.argv.includes('videoTo=tg') ? 'tg' : 'r2';
const GB = 1024;

const imgDown = (P.downGB * (1 - P.videoShare) * GB) / P.imgMB;
const vidRanges = (P.downGB * P.videoShare * GB) / P.rangeMB;
const imgUp = (P.upGB * (1 - P.videoShare) * GB) / P.imgMB;
const vidUp = (P.upGB * P.videoShare * GB) / P.vidMB;
const vidChunks = vidUp * Math.ceil(P.vidMB / P.chunkMB);

// Workers 请求
const workerVid = vidTo === 'r2' && P.r2Public ? 0 : vidRanges;
const workers = imgDown + workerVid + imgUp + vidUp * 2 + vidChunks + P.apiCalls + P.searches + 96;

// D1 行读写 (每次操作的行数是按代码路径数出来的估计值)
const d1Read = imgDown * 5 + workerVid * 4 + (imgUp + vidUp) * 20 + vidChunks * 4 + P.apiCalls * 30 + P.searches * P.nodes + 96 * 50;
const d1Write = imgUp * 15 + vidUp * 15 + vidChunks * 2 + 96 * 5;

// DO 请求: 每个 TG 分片 1 次 acquire
const tgMsgs = imgUp + (vidTo === 'tg' ? vidChunks : 0);
const doReq = tgMsgs * 1.05;

// R2
const r2Classa = vidTo === 'r2' ? vidUp * 2 + vidChunks : 0;
const r2Classb = vidTo === 'r2' ? vidRanges : 0;
const r2GrowGB = vidTo === 'r2' ? P.upGB * P.videoShare * 30 : 0;
let r2Year = 0;
for (let m = 1; m <= 12; m++) r2Year += Math.max(0, r2GrowGB * m - 10) * 0.015;

const rows = [
  ['Workers 请求/日', workers, 100000],
  ['D1 读行/日', d1Read, 5000000],
  ['D1 写行/日', d1Write, 100000],
  ['DO 请求/日', doReq, 100000],
  ['R2 A 类操作/月', r2Classa * 30, 1000000],
  ['R2 B 类操作/月', r2Classb * 30, 10000000],
  ['TG 消息/日 (单频道上限 15/分)', tgMsgs, 15 * 60 * 24],
];
console.log('参数', JSON.stringify({ ...P, videoTo: vidTo }));
console.log('项目'.padEnd(30), '用量'.padStart(12), '免费额度'.padStart(12), '占用'.padStart(8), '余量倍数'.padStart(8));
for (const [name, used, cap] of rows) {
  const pct = (used / cap) * 100;
  const head = used > 0 ? (cap / used).toFixed(1) + 'x' : '-';
  console.log(name.padEnd(30), Math.round(used).toLocaleString().padStart(12), cap.toLocaleString().padStart(12), (pct.toFixed(1) + '%').padStart(8), head.padStart(8));
}
console.log(`R2 存储每月增长 ${r2GrowGB} GB, 首年存储费约 $${r2Year.toFixed(0)} (超出 10 GB 部分 $0.015/GB-月)。`);

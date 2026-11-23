/**
 * ChannelLimiter: 全局唯一实例 (idFromName('global'))
 * - 每个频道一个令牌节拍: 两次发送间隔 >= 60s / rate, 再加 0~600ms 随机抖动
 * - 每个 Bot 记录冷却到期时间 (来自 429 retry_after 或连续失败)
 * - 轮询挑选可用 Bot
 * 冷却信息持久化到 DO 存储, 实例被回收也不丢。
 */
import { DurableObject } from 'cloudflare:workers';

export interface AcquireResult { ok: boolean; botId?: string; waitMs: number }

export class ChannelLimiter extends DurableObject {
  private nextAt = new Map<string, number>();
  private cooldown = new Map<string, number>();
  private rr = 0;
  private loaded = false;

  private async load() {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get<Record<string, number>>('cooldown');
    if (saved) for (const [k, v] of Object.entries(saved)) this.cooldown.set(k, v);
    this.loaded = true;
  }

  /**
   * 申请一次发送机会。
   * @param channelId 频道
   * @param botIds    候选 Bot
   * @param ratePerMin 频道每分钟上限
   * @param maxWaitMs 最多愿意等待多久; 超过就返回 ok=false 让调用方回 429
   */
  async acquire(channelId: string, botIds: string[], ratePerMin: number, maxWaitMs: number): Promise<AcquireResult> {
    await this.load();
    const t = Date.now();
    const ready = botIds.filter((id) => (this.cooldown.get(id) ?? 0) <= t);
    if (ready.length === 0) {
      const soonest = Math.min(...botIds.map((id) => this.cooldown.get(id) ?? t));
      return { ok: false, waitMs: Math.max(1000, soonest - t) };
    }
    const gap = Math.ceil(60_000 / Math.max(1, ratePerMin));
    const slot = Math.max(t, this.nextAt.get(channelId) ?? 0);
    const wait = slot - t;
    if (wait > maxWaitMs) return { ok: false, waitMs: wait };
    this.nextAt.set(channelId, slot + gap + Math.floor(Math.random() * 600));
    const botId = ready[this.rr++ % ready.length];
    return { ok: true, botId, waitMs: wait };
  }

  /** 上报 Bot 被限速或出错 */
  async penalize(botId: string, cooldownMs: number): Promise<void> {
    await this.load();
    this.cooldown.set(botId, Date.now() + cooldownMs);
    await this.ctx.storage.put('cooldown', Object.fromEntries(this.cooldown));
  }

  async clear(botId: string): Promise<void> {
    await this.load();
    if (this.cooldown.delete(botId)) await this.ctx.storage.put('cooldown', Object.fromEntries(this.cooldown));
  }

  async snapshot(): Promise<{ cooldown: Record<string, number>; nextAt: Record<string, number> }> {
    await this.load();
    return { cooldown: Object.fromEntries(this.cooldown), nextAt: Object.fromEntries(this.nextAt) };
  }
}

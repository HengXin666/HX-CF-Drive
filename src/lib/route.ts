/** 决定文件存到哪个后端 */
export type Driver = 'r2' | 'tg';

export interface RouteConfig { videoTo: Driver; r2MinBytes: number; hasBots: boolean }

export function chooseDriver(mime: string, size: number, cfg: RouteConfig, requested?: string): Driver {
  if (requested === 'r2') return 'r2';
  if (requested === 'tg' && cfg.hasBots) return 'tg';
  if (!cfg.hasBots) return 'r2';
  if (mime.startsWith('video/') && cfg.videoTo === 'r2') return 'r2';
  if (size >= cfg.r2MinBytes) return 'r2';
  return 'tg';
}

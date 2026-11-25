// 预览弹窗: 图片, 视频, 音频, PDF, 文本 (文本只取前 256 KB)
import { useEffect, useState } from 'react';
import { fmtSize, type Node } from '../lib/api';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui';
import { Icon } from './Icon';
import { useDemoSrc } from '../demo/media';

export interface PreviewTarget { node: Node; url: string }

function TextView({ url }: { url: string }) {
  const [text, setText] = useState('加载中...');
  useEffect(() => {
    fetch(url, { headers: { Range: 'bytes=0-262143' } }).then((r) => r.text()).then(setText, (e) => setText(String(e)));
  }, [url]);
  return <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{text}</pre>;
}

export function Preview({ target, onClose, onDownload }: { target: PreviewTarget | null; onClose: () => void; onDownload: (n: Node) => void }) {
  const mime = target?.node.mime ?? '';
  // 演示模式: 直链只存在于浏览器内的拦截层, 媒体元素先换成 blob URL
  const src = __DEMO__ ? useDemoSrc(target?.url) : target?.url;
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(92vw,1000px)] max-w-none sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 pr-8">
            <span className="min-w-0 flex-1 truncate">{target?.node.name}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">{target && fmtSize(target.node.size)}</span>
            {target && (
              <Button size="sm" variant="outline" onClick={() => onDownload(target.node)}>
                <Icon name="download" /> 下载
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>
        {target && (mime.startsWith('image/') ? (
          <img src={src} alt={target.node.name} className="max-h-[72vh] w-full rounded-lg object-contain" />
        ) : mime.startsWith('video/') ? (
          <video src={src} controls autoPlay className="max-h-[72vh] w-full rounded-lg bg-black" />
        ) : mime.startsWith('audio/') ? (
          <audio src={src} controls autoPlay className="w-full" />
        ) : mime.startsWith('text/') ? (
          <TextView url={target.url} />
        ) : (
          <iframe src={src} title={target.node.name} className="h-[72vh] w-full rounded-lg bg-white" />
        ))}
      </DialogContent>
    </Dialog>
  );
}

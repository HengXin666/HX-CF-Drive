// 接口文档: 认证方式, 接口清单 (可复制 curl), Agent 接入入口
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Page } from '../components/Shell';
import { curlOf, type Endpoint, GROUPS, type Method } from '../docs/endpoints';
import { Badge, Button, toast } from '../ui';

const METHOD_TONE: Record<Method, string> = {
  GET: 'bg-sky-400/15 text-sky-300',
  POST: 'bg-emerald-400/15 text-emerald-300',
  PUT: 'bg-amber-400/15 text-amber-300',
  PATCH: 'bg-violet-400/15 text-violet-300',
  DELETE: 'bg-rose-400/15 text-rose-300',
};
const SCOPE_TONE = { read: 'secondary', write: 'default', admin: 'warning', public: 'success' } as const;

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(() => toast.success('已复制'));
}

function Code({ children }: { children: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-border/40 bg-background/60 px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{children}</pre>
      <button type="button" aria-label="复制" title="复制" onClick={() => copy(children)}
        className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground">
        <Icon name="copy" />
      </button>
    </div>
  );
}

function Row({ e, base }: { e: Endpoint; base: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border/30 first:border-t-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30">
        <span className={`w-14 shrink-0 rounded-md py-0.5 text-center font-mono text-[11px] font-semibold ${METHOD_TONE[e.method]}`}>{e.method}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{e.path}</code>
        <span className="hidden min-w-0 shrink truncate text-[12.5px] text-muted-foreground md:block">{e.desc}</span>
        <Badge variant={SCOPE_TONE[e.scope]}>{e.scope}</Badge>
        <Icon name="chevron" className={`size-3.5 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="text-[13px] text-muted-foreground md:hidden">{e.desc}</p>
          {e.body && (<><div className="text-[12px] text-muted-foreground">请求体</div><Code>{e.body}</Code></>)}
          {e.resp && (<><div className="text-[12px] text-muted-foreground">返回</div><Code>{e.resp}</Code></>)}
          <div className="text-[12px] text-muted-foreground">示例</div>
          <Code>{curlOf(e, base)}</Code>
        </div>
      )}
    </div>
  );
}

export function ApiDocs() {
  const base = location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <Page
      title="接口文档"
      right={
        <>
          <Button size="sm" variant="outline" onClick={() => window.open(`${import.meta.env.BASE_URL}llms.txt`, '_blank')}><Icon name="fileText" /> llms.txt</Button>
          <Button size="sm" variant="primary" onClick={() => window.open(`${import.meta.env.BASE_URL}skill.md`, '_blank')}><Icon name="bolt" /> Agent Skill</Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-[960px] flex-col gap-5">
        <section className="grid gap-3 md:grid-cols-3">
          {[
            { icon: 'key' as const, t: '认证', d: 'Authorization: Bearer <token>。WebDAV 用 Basic, 密码填令牌。也可用 ?token=。' },
            { icon: 'warn' as const, t: '错误', d: '统一返回 {"error":"..."}。429 和 503 带 Retry-After, 按它等待后重试。' },
            { icon: 'server' as const, t: 'WebDAV', d: `${base}/dav/ , rclone, RaiDrive, Infuse, OpenList 都能挂载。单文件 ≤ 100 MB。` },
          ].map((c) => (
            <div key={c.t} className="rounded-xl border border-border/40 bg-card/40 p-4">
              <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold"><Icon name={c.icon} className="size-4 text-link" />{c.t}</div>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{c.d}</p>
            </div>
          ))}
        </section>
        <section className="rounded-xl border border-border/40 bg-card/40 p-4">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold"><Icon name="bolt" className="size-4 text-link" />让 Agent 接入</div>
          <p className="mb-2 text-[12.5px] leading-relaxed text-muted-foreground">
            把下面这句话发给 Agent (Claude Code, Codex, Cursor 等), 它会读取 Skill 并按规范调用接口。令牌请在后台签发受限令牌, 不要给管理员令牌。
          </p>
          <Code>{`读取 ${base}/skill.md , 按其中的说明使用 HX-CF-Drive。BASE=${base} , TOKEN=<你的受限令牌>`}</Code>
        </section>
        {GROUPS.map((g) => (
          <section key={g.id} className="overflow-hidden rounded-xl border border-border/40 bg-card/40">
            <div className="border-b border-border/40 px-4 py-3">
              <div className="text-[14px] font-semibold">{g.title}</div>
              {g.note && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{g.note}</p>}
            </div>
            {g.items.map((e) => <Row key={e.method + e.path} e={e} base={base} />)}
          </section>
        ))}
      </div>
    </Page>
  );
}

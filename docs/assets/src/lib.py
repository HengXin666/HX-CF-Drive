import html
FONT = "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace"
BG, CARD, CARD2, STROKE = '#22272e', '#2d333b', '#373e47', '#444c56'
TXT, SUB, MUTED = '#e6edf3', '#adbac7', '#768390'
OR, BL, PU, GR = '#f38020', '#2aabee', '#7c8cff', '#57ab5a'
WARN = []

def tw(s, size, mono=False, bold=False):
    w = 0
    for c in s:
        if ord(c) > 0x2e80: w += size * (1.0 if not mono else 1.0)
        elif mono: w += size * 0.62
        elif c in 'il.,:;|!\' ': w += size * 0.3
        elif c.isupper() or c in 'mw@%': w += size * 0.7
        else: w += size * 0.56
    return w * (1.06 if bold else 1)

def T(x, y, s, size=14, fill=TXT, anchor='start', bold=False, mono=False, maxw=None, op=None):
    if maxw is not None:
        w = tw(s, size, mono, bold)
        if w > maxw: WARN.append(f'overflow {w:.0f}>{maxw}: {s}')
    fam = ' class="m"' if mono else ''
    wt = ' font-weight="600"' if bold else ''
    o = f' opacity="{op}"' if op else ''
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" text-anchor="{anchor}"{wt}{fam}{o}>{html.escape(s)}</text>'

def R(x, y, w, h, fill=CARD, stroke=STROKE, rx=12, sw=1, dash=None, op=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    o = f' fill-opacity="{op}"' if op is not None else ''
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{o}{st}{d}/>'

def A(x1, y1, x2, y2, color=SUB, sw=1.6, dash=None, mid=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    if mid:
        pts = f'M{x1},{y1} ' + ' '.join(f'L{a},{b}' for a, b in mid) + f' L{x2},{y2}'
    else:
        pts = f'M{x1},{y1} L{x2},{y2}'
    mk = 'a' + color.strip('#')
    return f'<path d="{pts}" fill="none" stroke="{color}" stroke-width="{sw}"{d} marker-end="url(#{mk})"/>'

def P(d, stroke, sw=2, fill='none', extra=''):
    return f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"{extra}/>'

def C(cx, cy, r, fill, stroke=None, sw=1, op=None):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
    o = f' fill-opacity="{op}"' if op is not None else ''
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"{o}{st}/>'

def badge(x, y, n, color):
    return C(x, y, 13, color) + T(x, y + 5, str(n), 14, BG, 'middle', True)

def svg(w, h, body, title):
    marks = ''.join(
        f'<marker id="a{c.strip("#")}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
        for c in (SUB, OR, BL, PU, GR, MUTED))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(title)}">
<title>{html.escape(title)}</title>
<style>text{{font-family:{FONT};}} .m{{font-family:{MONO};}}</style>
<defs>{marks}
<linearGradient id="gOr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{OR}"/><stop offset="1" stop-color="#f6a04d"/></linearGradient>
<linearGradient id="gBl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{BL}"/><stop offset="1" stop-color="{PU}"/></linearGradient>
</defs>
<rect width="{w}" height="{h}" rx="16" fill="{BG}"/>
{body}
</svg>
'''

def write(name, w, h, body, title):
    s = svg(w, h, '\n'.join(body) if isinstance(body, list) else body, title)
    open(f'docs/assets/{name}.svg', 'w').write(s)

def pill(cx, y, s, size=12, fill=SUB, mono=False, bg=BG, anchor='middle'):
    w = tw(s, size, mono) + 12
    x = cx - w / 2 if anchor == 'middle' else cx - 6
    return R(round(x, 1), y - size - 2, round(w, 1), size + 8, bg, None, 5) + T(cx, y, s, size, fill, anchor, mono=mono)

def msg(x1, x2, y, label, color=SUB, dash=None, mono=False, size=12, sub=None, bg=BG):
    o = A(x1, y, x2 + (-3 if x2 > x1 else 3), y, color, 1.6, dash)
    cx = (x1 + x2) / 2
    if label: o += pill(cx, y - 8, label, size, color if color != SUB else TXT, mono, bg)
    if sub: o += pill(cx, y + 20, sub, 11.5, SUB, bg=bg)
    return o

def blend(c, a, base=BG):
    f = lambda h: [int(h[i:i+2], 16) for i in (1, 3, 5)]
    x, y = f(c), f(base)
    return '#' + ''.join(f'{round(y[i] + a * (x[i] - y[i])):02x}' for i in range(3))

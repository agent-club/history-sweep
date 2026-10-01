import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

const C = {paper: '#f7f5ef', ink: '#292e26', rust: '#af5031', sage: '#e7e9df', line: '#ddded3', muted: '#73766b', white: '#fffefa'};
const serif = 'Georgia, "Songti SC", "STSong", "Noto Serif CJK SC", serif';
const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';

const copy = {
  en: {
    opening: 'A little less history.',
    search: 'Find the pages you mean.',
    select: 'Choose what can go.',
    confirm: 'One last look.',
    finish: 'Room for what’s next.',
    end: 'Room for what’s next.',
    placeholder: 'Search sites or keywords', date: 'Last 7 days', matches: '3 matching pages',
    rows: [['x.com/home', 'Today · 9:42 AM'], ['x.com/explore', 'Yesterday · 6:18 PM'], ['x.com/i/bookmarks', 'Monday · 11:06 AM']],
    count: '3 pages selected', warning: 'This action can’t be undone.', button: 'Delete 3 pages', done: '3 pages cleared',
  },
  zh: {
    opening: '少一点历史，多一点空间。',
    search: '找到想要清理的页面。',
    select: '选择要告别的内容。',
    confirm: '确认前，再看一眼。',
    finish: '为下一页留出空间。',
    end: '为下一页留出空间。',
    placeholder: '搜索网站或关键词', date: '最近 7 天', matches: '找到 3 条记录',
    rows: [['x.com/home', '今天 · 9:42'], ['x.com/explore', '昨天 · 18:18'], ['x.com/i/bookmarks', '周一 · 11:06']],
    count: '已选择 3 个页面', warning: '删除后无法撤销。', button: '删除 3 个页面', done: '已清理 3 个页面',
  },
};

const ease = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const fade = (f, start = 0, length = 10) => interpolate(f, [start, start + length], [0, 1], ease);
const rise = (f, start = 0) => interpolate(f, [start, start + 12], [18, 0], ease);

function Mark({size = 42}) {
  return <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
    <rect x="16" y="16" width="96" height="96" rx="27" fill="#20242d"/>
    <path d="M43 47h30M43 62h21M43 77h10" stroke="#ffffff" strokeWidth="7" strokeLinecap="round"/>
    <path d="m65 83 25-31M79 51l12-1 1 12" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

function Orbit({frame}) {
  const drift = interpolate(frame, [0, 270], [-5, 5], ease);
  return <AbsoluteFill style={{overflow: 'hidden', pointerEvents: 'none'}}>
    <div style={{position: 'absolute', left: '50%', top: '48%', width: 870, height: 600, border: `1px solid ${C.line}`, borderRadius: '50%', transform: `translate(-50%,-50%) rotate(-26deg) translateY(${drift}px)`}} />
    <div style={{position: 'absolute', left: '50%', top: '48%', width: 680, height: 840, border: `1px solid ${C.line}`, borderRadius: '50%', transform: 'translate(-50%,-50%) rotate(18deg)', opacity: .64}} />
    <div style={{position: 'absolute', left: 73, top: 228, width: 7, height: 7, borderRadius: '50%', background: C.rust, opacity: .6}} />
    <div style={{position: 'absolute', right: 74, bottom: 208, width: 5, height: 5, borderRadius: '50%', background: C.ink, opacity: .32}} />
  </AbsoluteFill>;
}

function Label({children, style = {}}) {
  return <div style={{fontFamily: sans, color: C.rust, fontSize: 11, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', ...style}}>{children}</div>;
}

function Headline({children, f, start, size = 43, style = {}}) {
  return <div style={{fontFamily: serif, fontSize: size, fontWeight: 400, lineHeight: 1.2, letterSpacing: -1.1, color: C.ink, opacity: fade(f, start, 12), transform: `translateY(${rise(f, start)}px)`, textAlign: 'center', ...style}}>{children}</div>;
}

function BrandHeader({small = false}) {
  return <div style={{display: 'flex', alignItems: 'center', gap: 11, fontFamily: sans, color: C.ink, fontWeight: 600, fontSize: small ? 15 : 18, letterSpacing: -.45}}><Mark size={small ? 34 : 42}/>History Sweep</div>;
}

function Cursor({x, y, f, start}) {
  const op = fade(f, start, 7);
  return <div style={{position: 'absolute', left: x, top: y, zIndex: 9, opacity: op, transform: `translate(${interpolate(f, [start, start + 18], [22, 0], ease)}px,${interpolate(f, [start, start + 18], [12, 0], ease)}px)`, width: 0, height: 0, borderLeft: '9px solid #292e26', borderTop: '2px solid transparent', borderBottom: '14px solid transparent', filter: 'drop-shadow(1px 1px 0 white)'}} />;
}

function Stage({children, frame, start, style = {}}) {
  const local = frame - start;
  const {fps, durationInFrames} = useVideoConfig();
  const entrance = spring({frame: Math.max(0, local), fps, config: {damping: 22, mass: .8, stiffness: 105}});
  const opacity = interpolate(local, [-8, 0, 7], [0, 0, 1], ease);
  // Hold the final shot: the landing page stops here instead of looping the film.
  const exit = start + 62 >= durationInFrames ? 1 : interpolate(local, [44, 54, 62], [1, 1, 0], ease);
  return <AbsoluteFill style={{opacity: opacity * exit, transform: `translateY(${(1 - entrance) * 15}px)`, ...style}}>{children}</AbsoluteFill>;
}

function OpeningScene({f, lang}) {
  return <Stage frame={f} start={0} style={{justifyContent: 'center', alignItems: 'center'}}>
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 38}}>
      <div style={{opacity: fade(f, 5, 12), transform: `scale(${interpolate(f, [5, 19], [.92, 1], ease)})`}}><BrandHeader/></div>
      <Headline f={f} start={16} size={lang === 'zh' ? 55 : 56} style={{maxWidth: 660}}>{copy[lang].opening}</Headline>
      <Label style={{opacity: fade(f, 30, 9), color: C.muted, fontSize: 10, letterSpacing: 1.7}}>{lang === 'zh' ? '一款轻巧的浏览历史整理工具' : 'A quieter way to clear your browsing history'}</Label>
      <div style={{position: 'absolute', bottom: 149, opacity: fade(f, 35, 8)}}><span style={{border: `1px solid ${C.line}`, background: '#fffefaab', padding: '9px 15px', borderRadius: 30, font: `10px ${sans}`, color: C.muted, letterSpacing: 1.2}}>{lang === 'zh' ? '功能演示' : 'ILLUSTRATIVE DEMO'}</span></div>
    </div>
  </Stage>;
}

function BrowserCard({children, width = 530, style = {}}) {
  return <div style={{width, border: `1px solid #d9dbcf`, borderRadius: 15, background: C.white, boxShadow: '0 26px 75px rgba(41,46,38,.09)', overflow: 'hidden', ...style}}>
    <div style={{height: 39, background: '#f0f0e9', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 6, padding: '0 15px'}}>
      {[0, 1, 2].map(i => <span key={i} style={{width: 6, height: 6, borderRadius: 5, background: '#c6c9bd'}}/>)}
      <span style={{marginLeft: 10, border: `1px solid ${C.line}`, background: '#fafaf6', color: C.muted, height: 21, borderRadius: 4, padding: '3px 10px', font: `9px ${sans}`, width: 175}}>history-sweep.local</span>
      <span style={{marginLeft: 'auto', font: `9px ${sans}`, color: C.muted}}>x.com</span>
    </div>{children}
  </div>;
}

function SearchScene({f, lang}) {
  const c = copy[lang];
  const progress = interpolate(f, [58, 77], [0, 1], ease);
  return <Stage frame={f} start={45} style={{alignItems: 'center', justifyContent: 'center'}}>
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22}}>
      <Headline f={f} start={48} size={lang === 'zh' ? 38 : 42}>{c.search}</Headline>
      <BrowserCard width={680}>
        <div style={{padding: '31px 38px 33px'}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24}}><BrandHeader small/><span style={{font: `10px ${sans}`, color: C.muted}}>{lang === 'zh' ? '搜索历史' : 'History search'}</span></div>
          <div style={{height: 55, border: `1px solid ${C.rust}`, background: '#fffefa', borderRadius: 7, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12, boxShadow: '0 0 0 3px #af50310b'}}>
            <span style={{fontSize: 28, color: C.muted}}>⌕</span><span style={{font: `26px ${sans}`, color: C.ink, letterSpacing: .3}}>x.com</span><span style={{marginLeft: 'auto', width: 1, height: 28, background: C.rust, opacity: interpolate(f, [47, 53], [1, .2], {extrapolateRight: 'clamp'})}} />
          </div>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 15}}>
            <span style={{font: `20px ${sans}`, color: C.muted}}>{c.date} <span style={{color: C.rust}}>⌄</span></span>
            <span style={{font: `18px ${sans}`, color: C.muted, opacity: progress}}>{c.matches}</span>
          </div>
        </div>
      </BrowserCard>
      <Label style={{fontSize: 10, color: C.muted, letterSpacing: 1}}>{lang === 'zh' ? '按网站与日期筛选' : 'Search by site. Narrow by date.'}</Label>
    </div>
    <Cursor x={605} y={430} f={f} start={51}/>
  </Stage>;
}

function Check({visible, size = 17}) {
  return <div style={{width: size, height: size, borderRadius: 5, border: `1px solid ${visible ? C.rust : '#c9cbbf'}`, background: visible ? C.rust : 'transparent', display: 'grid', placeItems: 'center', flex: 'none'}}>
    {visible && <svg width={size - 5} height={size - 5} viewBox="0 0 12 12"><path d="m2 6 2.5 2.5L10 3" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
  </div>;
}

function SelectScene({f, lang}) {
  const c = copy[lang];
  return <Stage frame={f} start={105} style={{alignItems: 'center', justifyContent: 'center'}}>
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22}}>
      <Headline f={f} start={108} size={lang === 'zh' ? 39 : 42}>{c.select}</Headline>
      <BrowserCard width={680}>
        <div style={{padding: '26px 36px 27px'}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 14, borderBottom: `1px solid ${C.line}`}}>
            <div style={{font: `22px ${sans}`, color: C.ink}}>{c.matches}</div>
            <div style={{font: `20px ${sans}`, color: C.rust}}>{lang === 'zh' ? '全选' : 'Select all'}　✓</div>
          </div>
          {c.rows.map((row, i) => {
            const tick = f >= 117 + i * 7;
            return <div key={row[0]} style={{height: 75, display: 'flex', alignItems: 'center', borderBottom: i < 2 ? `1px solid #eeeee7` : 'none', gap: 16, opacity: fade(f, 110 + i * 6, 8)}}>
              <Check visible={tick} size={22}/><div style={{width: 38, height: 38, borderRadius: 9, background: C.sage, color: C.ink, display: 'grid', placeItems: 'center', font: `16px ${sans}`}}>x</div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 5}}><span style={{font: `24px ${sans}`, color: C.ink}}>{row[0]}</span><span style={{font: `18px ${sans}`, color: C.muted}}>{row[1]}</span></div>
              <span style={{marginLeft: 'auto', font: `14px ${sans}`, color: C.muted}}>↗</span>
            </div>;
          })}
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 17, borderTop: `1px solid ${C.line}`, marginTop: 1}}><span style={{font: `18px ${sans}`, color: C.muted}}>{c.count}</span><span style={{font: `18px ${sans}`, color: C.rust}}>{lang === 'zh' ? '下一步　→' : 'Continue　→'}</span></div>
        </div>
      </BrowserCard>
      <Label style={{fontSize: 10, color: C.muted, letterSpacing: 1}}>{lang === 'zh' ? '逐条预览，再选择' : 'Review each page. Select with care.'}</Label>
    </div>
    <Cursor x={714} y={550} f={f} start={120}/>
  </Stage>;
}

function ConfirmScene({f, lang}) {
  const c = copy[lang];
  const scale = spring({frame: Math.max(0, f - 174), fps: 30, config: {damping: 16, stiffness: 115, mass: .65}});
  return <Stage frame={f} start={165} style={{alignItems: 'center', justifyContent: 'center'}}>
    <div style={{position: 'absolute', inset: 0, background: `rgba(41,46,38,${interpolate(f, [167, 180], [0, .12], ease)})`}}/>
    <div style={{position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 23}}>
      <Headline f={f} start={167} size={lang === 'zh' ? 39 : 42}>{c.confirm}</Headline>
      <div style={{width: 530, borderRadius: 15, border: `1px solid ${C.line}`, background: C.white, boxShadow: '0 26px 70px rgba(41,46,38,.16)', padding: '35px 40px 34px', transform: `scale(${.96 + .04 * scale})`, opacity: fade(f, 171, 9)}}>
        <div style={{width: 48, height: 48, borderRadius: '50%', background: '#f5ebe5', display: 'grid', placeItems: 'center', color: C.rust, font: `23px ${serif}`, margin: '0 auto 19px'}}>!</div>
        <div style={{textAlign: 'center', color: C.ink, font: `27px ${serif}`, marginBottom: 12}}>{c.count}</div>
        <div style={{textAlign: 'center', color: C.muted, font: `20px ${sans}`, marginBottom: 26}}>{c.warning}</div>
        <div style={{height: 54, borderRadius: 7, background: C.ink, color: C.white, display: 'grid', placeItems: 'center', font: `20px ${sans}`, letterSpacing: .1, transform: `scale(${interpolate(f, [184, 192], [1, .98], ease)})`}}>{c.button}</div>
      </div>
      <Label style={{fontSize: 10, color: C.muted, letterSpacing: 1}}>{lang === 'zh' ? '确认后清理无法撤销' : 'Deletion is permanent once confirmed'}</Label>
    </div>
    <Cursor x={561} y={561} f={f} start={187}/>
  </Stage>;
}

function FinishScene({f, lang}) {
  const c = copy[lang];
  const ring = interpolate(f, [215, 244], [0, 1], ease);
  const scale = spring({frame: Math.max(0, f - 218), fps: 30, config: {damping: 12, stiffness: 110, mass: .55}});
  return <Stage frame={f} start={210} style={{alignItems: 'center', justifyContent: 'center'}}>
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 25}}>
      <div style={{width: 82, height: 82, position: 'relative', display: 'grid', placeItems: 'center', transform: `scale(${.82 + .18 * scale})`}}>
        <div style={{position: 'absolute', inset: 0, borderRadius: '50%', border: `1px solid ${C.rust}`, transform: `scale(${.82 + ring * .18})`, opacity: 1 - ring * .4}}/>
        <div style={{width: 58, height: 58, borderRadius: '50%', background: C.sage, display: 'grid', placeItems: 'center', color: C.rust, fontSize: 25}}>✓</div>
      </div>
      <Label style={{opacity: fade(f, 226, 8)}}>{c.done}</Label>
      <Headline f={f} start={230} size={lang === 'zh' ? 46 : 50} style={{maxWidth: 640}}>{c.end}</Headline>
      <div style={{font: `11px ${sans}`, color: C.muted, opacity: fade(f, 241, 8), letterSpacing: .4}}>{lang === 'zh' ? 'History Sweep · 留一点过去，多一点空间' : 'History Sweep · A little less history, a little more space'}</div>
    </div>
    <div style={{position: 'absolute', bottom: 120, opacity: fade(f, 240, 8)}}><span style={{border: `1px solid ${C.line}`, padding: '9px 15px', borderRadius: 30, font: `10px ${sans}`, color: C.muted, letterSpacing: 1.2}}>{lang === 'zh' ? '功能演示' : 'ILLUSTRATIVE DEMO'}</span></div>
  </Stage>;
}

export const Opening = ({lang = 'en'}) => {
  const frame = useCurrentFrame();
  const language = lang === 'zh' ? 'zh' : 'en';
  return <AbsoluteFill style={{backgroundColor: C.paper, color: C.ink, fontFamily: sans}}>
    <Orbit frame={frame}/>
    <div style={{position: 'absolute', top: 45, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 5, opacity: interpolate(frame, [0, 18], [0, .9], ease)}}>
      <span style={{font: `9px ${sans}`, color: C.muted, letterSpacing: 1.55, borderBottom: `1px solid ${C.line}`, paddingBottom: 9}}>{language === 'zh' ? 'HISTORY SWEEP　·　功能演示' : 'HISTORY SWEEP　·　ILLUSTRATIVE DEMO'}</span>
    </div>
    <OpeningScene f={frame} lang={language}/>
    <SearchScene f={frame} lang={language}/>
    <SelectScene f={frame} lang={language}/>
    <ConfirmScene f={frame} lang={language}/>
    <FinishScene f={frame} lang={language}/>
  </AbsoluteFill>;
};

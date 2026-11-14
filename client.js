// Client half of @local/dsh-memory: left-sidebar entry + the DSH-styled 记忆 page.
//
// Visual language follows the bundled DSH desktop design system, not Hermes:
//   * DELIBERATE DIVERGENCE: the reference panel (spec/hermes-memory-model.md §7) accents with
//     --ui-accent = #196d31 (Hermes' github theme green). That value is intentionally NOT copied —
//     the user asked for a page in DSH's own desktop language, so the primary button uses
//     --dsw-alias-brand-primary and the budget bar uses the state-success/warn/error tokens.
//     If this ever looks inconsistent with the reference, it is a decision, not an oversight.
//   * colours come only from the --dsw-alias-* tokens listed in CONTRACT.md
//     (bg-base / bg-layer-1..3, label-primary..tertiary, border-l1..l2, brand-primary,
//      state-success / state-warn / state-error) — there is no literal colour in this file;
//   * corner radii and the type scale follow the DSH shell
//     (--dsw-radius-* with px fallbacks; 17 / 14.5 / 13 / 12.5 / 12 / 11.5 / 10.5 px);
//   * registrations mirror the skill-explorer panel (sidebar.panellist icon + main keyed page).
//
// Six regions, in order: header, four statistic cards, 记忆筛选, 内置记忆,
// 已配置的记忆提供方 (with the filtered fact list), 会话搜索.
//
// Every read from /api/dsh-memory/* is optional-safe: a missing field, a non-200 response or a
// thrown fetch renders an inline error strip and leaves the rest of the page alive.
// All user-visible strings come from the locale dicts (Chinese first, English second).
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-memory';
    const NS = 'dsh-memory';
    const ORDER = 41;
    const API = '/api/dsh-memory';

    // ------------------------------------------------------------------ locale
    const DICTS = {
      zh: {
        'entry.label': '记忆',
        'page.title': '记忆',
        'page.badge': 'Holographic',
        'page.subtitle': '本地记忆：Markdown 记忆文件 + Holographic 事实库',
        'page.readonly': '只读',
        'act.refresh': '刷新',
        'act.refreshing': '刷新中…',
        'stat.builtin': '内置条目',
        'stat.builtinSub': 'MEMORY.md + USER.md',
        'stat.providers': '启用的记忆提供方',
        'stat.providersSub': 'Holographic',
        'stat.facts': 'Holographic 事实',
        'stat.factsSub': '{n} 显示',
        'stat.snapshot': '快照更新时间',
        'stat.snapshotSub': 'v{version}',
        'stat.embed': '语义向量',
        'stat.embedSub': '{state} · {n} 向量',
        'stat.embedReady': '就绪',
        'stat.embedLoading': '加载中',
        'stat.embedFailed': '失败',
        'stat.embedOff': '未启用',
        'filter.title': '记忆筛选',
        'filter.search': '内容、事实或标签...',
        'filter.category': '分类',
        'filter.allCategories': '全部分类',
        'filter.minTrust': '最低信任度',
        'filter.limit': '结果上限',
        'filter.apply': '应用筛选 / 刷新',
        'filter.hint': '筛选会重新查询事实库，并同步更新下方的提供方列表。',
        'builtin.title': '内置记忆',
        'builtin.available': '可用',
        'builtin.unavailable': '不可用',
        'builtin.chars': '字符用量 {chars} / {budget} 字符',
        'builtin.used': '已用 {percent}%',
        'builtin.mtime': '修改时间 {t}',
        'builtin.never': '未修改',
        'builtin.entries': '{n} 条条目',
        'builtin.fileCount': '{n} 个文件',
        'builtin.empty': '这个记忆文件还没有条目。',
        'builtin.none': '没有找到内置记忆文件。',
        'providers.title': '已配置的记忆提供方',
        'providers.configured': '已配置',
        'providers.available': '可用',
        'providers.unavailable': '不可用',
        'providers.facts': '事实',
        'providers.shown': '显示',
        'providers.entities': '实体',
        'providers.stores': '记忆库',
        'providers.overview': '概览',
        'providers.overviewHide': '收起概览',
        'providers.backend': '后端',
        'providers.relations': '关系',
        'providers.snapshot': '快照',
        'providers.categories': '分类',
        'providers.path': '存储路径',
        'providers.none': '没有已配置的记忆提供方。',
        'facts.title': '事实列表',
        'facts.count': '共 {n} 条',
        'facts.filtered': '筛选后 {n} 条',
        'facts.empty': '没有匹配的事实。',
        'fact.id': '事实 #{id}',
        'fact.trust': '信任度 {v}',
        'fact.searched': '检索到 {n}x',
        'fact.helpful': '有帮助 {n}x',
        'fact.downvote': '降权',
        'fact.updated': '更新时间 {t}',
        'fact.created': '创建时间 {t}',
        'events.timeline': '事件时间线',
        'sessions.title': '会话搜索',
        'sessions.fieldLabel': '搜索',
        'sessions.search': '搜索会话内容...',
        'sessions.source': '来源',
        'sessions.allSources': '全部来源',
        'sessions.sort': '排序方式',
        'sessions.recent': '最新优先',
        'sessions.oldest': '最早优先',
        'sessions.go': '搜索会话',
        'sessions.matches': '{n} 处匹配',
        'sessions.updated': '更新于 {t}',
        'sessions.empty': '没有匹配的会话。',
        'sessions.hint': '在 DSH 的本地会话记录中检索相关片段。',
        'common.loading': '加载中…',
        'common.none': '—',
        'err.fetch': '请求失败',
        'err.badjson': '响应不是有效的 JSON',
        'err.title': '部分数据加载失败',
      },
      en: {
        'entry.label': 'Memory',
        'page.title': 'Memory',
        'page.badge': 'Holographic',
        'page.subtitle': 'Local memory: Markdown memory files + Holographic fact store',
        'page.readonly': 'Read-only',
        'act.refresh': 'Refresh',
        'act.refreshing': 'Refreshing…',
        'stat.builtin': 'Built-in entries',
        'stat.builtinSub': 'MEMORY.md + USER.md',
        'stat.providers': 'Enabled providers',
        'stat.providersSub': 'Holographic',
        'stat.facts': 'Holographic facts',
        'stat.factsSub': '{n} shown',
        'stat.snapshot': 'Snapshot time',
        'stat.snapshotSub': 'v{version}',
        'stat.embed': 'Semantic vectors',
        'stat.embedSub': '{state} · {n} vectors',
        'stat.embedReady': 'ready',
        'stat.embedLoading': 'loading',
        'stat.embedFailed': 'failed',
        'stat.embedOff': 'off',
        'filter.title': 'Memory filter',
        'filter.search': 'Content, fact or tag…',
        'filter.category': 'Category',
        'filter.allCategories': 'All categories',
        'filter.minTrust': 'Minimum trust',
        'filter.limit': 'Result limit',
        'filter.apply': 'Apply filter / refresh',
        'filter.hint': 'Filtering re-queries the fact store and updates the provider list below.',
        'builtin.title': 'Built-in memory',
        'builtin.available': 'Available',
        'builtin.unavailable': 'Unavailable',
        'builtin.chars': 'Characters {chars} / {budget}',
        'builtin.used': '{percent}% used',
        'builtin.mtime': 'Modified {t}',
        'builtin.never': 'never modified',
        'builtin.entries': '{n} entries',
        'builtin.fileCount': '{n} files',
        'builtin.empty': 'This memory file has no entries yet.',
        'builtin.none': 'No built-in memory files found.',
        'providers.title': 'Configured memory providers',
        'providers.configured': 'Configured',
        'providers.available': 'Available',
        'providers.unavailable': 'Unavailable',
        'providers.facts': 'Facts',
        'providers.shown': 'Shown',
        'providers.entities': 'Entities',
        'providers.stores': 'Stores',
        'providers.overview': 'Overview',
        'providers.overviewHide': 'Hide overview',
        'providers.backend': 'Backend',
        'providers.relations': 'Relations',
        'providers.snapshot': 'Snapshot',
        'providers.categories': 'Categories',
        'providers.path': 'Store path',
        'providers.none': 'No configured memory providers.',
        'facts.title': 'Fact list',
        'facts.count': '{n} total',
        'facts.filtered': '{n} filtered',
        'facts.empty': 'No matching facts.',
        'fact.id': 'Fact #{id}',
        'fact.trust': 'Trust {v}',
        'fact.searched': 'Retrieved {n}x',
        'fact.helpful': 'Helpful {n}x',
        'fact.downvote': 'Down',
        'fact.updated': 'Updated {t}',
        'fact.created': 'Created {t}',
        'events.timeline': 'Event timeline',
        'sessions.title': 'Session search',
        'sessions.fieldLabel': 'Search',
        'sessions.search': 'Search session content…',
        'sessions.source': 'Source',
        'sessions.allSources': 'All sources',
        'sessions.sort': 'Sort',
        'sessions.recent': 'Newest first',
        'sessions.oldest': 'Oldest first',
        'sessions.go': 'Search sessions',
        'sessions.matches': '{n} matches',
        'sessions.updated': 'Updated {t}',
        'sessions.empty': 'No matching sessions.',
        'sessions.hint': "Search snippets in DSH's local session history.",
        'common.loading': 'Loading…',
        'common.none': '—',
        'err.fetch': 'Request failed',
        'err.badjson': 'Response was not valid JSON',
        'err.title': 'Some data failed to load',
      },
    };

    // Fallback formatter when the host locale service is absent (e.g. the standalone preview).
    let tt = (key, vars) => {
      const base = DICTS.zh[key] != null ? DICTS.zh[key] : (DICTS.en[key] != null ? DICTS.en[key] : key);
      if (!vars) return base;
      return String(base).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    };

    // -------------------------------------------------------------------- styles
    // Every colour is a token reference. Layer fallbacks chain to tokens too, so the page still
    // renders sensibly if the host only defines a subset.
    const CSS = [
      '.mm-view{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5;}',
      '.mm-body{flex:1;min-height:0;overflow:auto;padding:4px 28px 34px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;}',
      '.mm-body::-webkit-scrollbar{width:8px;height:8px;}',
      '.mm-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:99px;border:2px solid transparent;background-clip:content-box;}',
      '.mm-body::-webkit-scrollbar-track{background:transparent;}',
      '@keyframes mm-spin{to{transform:rotate(360deg)}}',
      '@keyframes mm-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
      '@keyframes mm-pulse{0%,100%{opacity:.55}50%{opacity:1}}',

      // 1. header
      '.mm-head{display:flex;align-items:center;gap:14px;padding:22px 28px 16px;}',
      '.mm-logo{width:38px;height:38px;flex:none;border-radius:var(--dsw-radius-sm,10px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);}',
      '.mm-htxt{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.mm-tline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.mm-title{font-size:17px;font-weight:640;letter-spacing:.01em;line-height:1.25;}',
      '.mm-sub{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mm-acts{display:flex;gap:8px;align-items:center;flex:none;}',

      // 2. statistic cards
      '.mm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(172px,1fr));gap:12px;animation:mm-fade .2s ease;}',
      '.mm-stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);padding:14px 16px;min-width:0;}',
      '.mm-stat .mm-slabel{font-size:11.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mm-stat .mm-svalue{font-size:22px;font-weight:640;line-height:1.35;margin-top:4px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mm-stat .mm-ssub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

      // ---- layout scaffold -------------------------------------------------
      '.mm-main{max-width:1180px;margin:0 auto;width:100%;}',
      '.mm-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px;align-items:start;}',
      '.mm-col{display:flex;flex-direction:column;gap:14px;min-width:0;}',
      '.mm-col:first-child .mm-panel:first-child,.mm-col:last-child .mm-panel:first-child{margin-top:0;}',
      // panels
      '.mm-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,14px);padding:0;margin-top:14px;min-width:0;display:flex;flex-direction:column;}',
      '.mm-panel-head{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}',
      '.mm-panel-head h3{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary);letter-spacing:.01em;margin:0;flex:1;min-width:0;display:flex;align-items:center;gap:8px;}',
      '.mm-panel-body{padding:15px 18px;min-width:0;}',
      '.mm-aside{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.mm-picon{width:24px;height:24px;flex:none;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);}',
      '.mm-note{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-left:2px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm,8px);padding:9px 12px;margin-top:10px;}',

      // 3. filter bar
      '.mm-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:12px 14px;align-items:end;}',
      '.mm-field{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.mm-field.mm-grow{grid-column:1 / -1;}',
      '.mm-flabel{font-size:11.5px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;}',
      '.mm-search{display:flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);min-width:0;}',
      '.mm-search:focus-within{border-color:var(--dsw-alias-brand-primary);}',
      '.mm-search svg{flex:none;color:var(--dsw-alias-label-tertiary);}',
      '.mm-input{flex:1;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;outline:0;font-family:inherit;}',
      '.mm-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.mm-selectwrap{position:relative;display:inline-flex;align-items:center;}',
      '.mm-selectwrap svg{position:absolute;right:9px;pointer-events:none;color:var(--dsw-alias-label-tertiary);}',
      '.mm-select{height:32px;min-width:130px;appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,8px);padding:0 28px 0 11px;font-size:12.5px;cursor:pointer;font-family:inherit;}',
      '.mm-select:hover{border-color:var(--dsw-alias-border-l2);}',

      // buttons
      '.mm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,8px);height:32px;padding:0 13px;font-size:12.5px;font-weight:520;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;transition:opacity .18s,border-color .18s,background .18s;}',
      '.mm-btn:hover{border-color:var(--dsw-alias-border-l2);}',
      '.mm-btn:disabled{opacity:.45;cursor:default;}',
      '.mm-btn.mm-primary{background:var(--dsw-alias-state-success-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:600;}',
      '.mm-btn.mm-primary:hover{opacity:.88;}',
      '.mm-btn.mm-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);height:28px;padding:0 10px;}',
      '.mm-btn.mm-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.mm-btn:focus-visible,.mm-select:focus-visible,.mm-input:focus-visible,.mm-chipbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.mm-spin{animation:mm-spin .8s linear infinite;}',

      // chips
      '.mm-chip{display:inline-flex;align-items:center;gap:5px;border-radius:99px;padding:1.5px 9px 1.5px 7px;font-size:11.5px;font-weight:520;line-height:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;}',
      '.mm-chip.mm-ok{color:var(--dsw-alias-state-success-primary);}',
      '.mm-chip.mm-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.mm-chip.mm-err{color:var(--dsw-alias-state-error-primary);}',
      '.mm-chip.mm-brand{color:var(--dsw-alias-brand-primary);}',
      '.mm-chip.mm-plain{padding:1.5px 9px;}',
      '.mm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;display:inline-block;}',
      '.mm-chipbtn{appearance:none;font-family:inherit;cursor:pointer;transition:border-color .18s,color .18s;}',
      '.mm-chipbtn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}',

      // events timeline
      '.mm-events{margin-top:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);padding:10px;}',
      '.mm-events-head{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px;}',
      '.mm-events-head svg{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .18s;}',
      '.mm-events.mm-closed .mm-events-head{margin-bottom:0;}',
      '.mm-events.mm-open .mm-events-head svg{transform:rotate(90deg);}',
      '.mm-events-item{font-size:12px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:6px;align-items:baseline;}',
      '.mm-events-item:last-child{border-bottom:0;}',
      '.mm-events-time{color:var(--dsw-alias-label-tertiary);flex:none;}',
      '.mm-events-text{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

      // code
      '.mm-code{font-family:ui-monospace,"SF Mono","JetBrains Mono",Consolas,"Liberation Mono",monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);padding:2px 7px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;display:inline-block;vertical-align:middle;}',

      // 4. built-in memory files
      '.mm-files{display:flex;flex-direction:column;gap:12px;}',
      '.mm-file{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);padding:14px 16px;min-width:0;display:flex;flex-direction:column;gap:11px;}',
      '.mm-fhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.mm-fname{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mm-fmeta{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.mm-frow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.mm-bar{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));overflow:hidden;}',
      '.mm-bar > i{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-state-success-primary);}',
      '.mm-bar.mm-warn > i{background:var(--dsw-alias-state-warn-primary);}',
      '.mm-bar.mm-err > i{background:var(--dsw-alias-state-error-primary);}',
      '.mm-entries{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;padding-right:2px;scrollbar-width:thin;}',
      '.mm-entry{display:flex;gap:9px;align-items:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);padding:8px 10px;}',
      '.mm-idx{flex:none;font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);padding:1px 6px;line-height:16px;}',
      '.mm-etext{font-size:12.5px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-width:0;}',

      // 5. providers + facts
      '.mm-prov{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);padding:14px 16px;margin-bottom:12px;min-width:0;}',
      '.mm-phead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.mm-pname{font-size:14px;font-weight:620;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}',
      '.mm-counters{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 6px;}',
      '.mm-counter{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);padding:9px 12px;min-width:0;}',
      '.mm-cval{font-size:17px;font-weight:640;font-variant-numeric:tabular-nums;line-height:1.2;}',
      '.mm-clabel{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;}',
      '.mm-ov{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 18px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);animation:mm-fade .2s ease;}',
      '.mm-ovrow{display:flex;gap:10px;align-items:baseline;padding:3px 0;min-width:0;}',
      '.mm-ovk{flex:none;min-width:66px;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.mm-ovv{font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
      '.mm-facts{display:flex;flex-direction:column;gap:10px;margin-top:6px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.mm-fact{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);padding:13px 15px;min-width:0;}',
      '.mm-fhead2{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:8px;}',
      '.mm-fid{font-family:ui-monospace,"SF Mono",Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary);}',
      '.mm-fcontent{font-size:13px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;line-height:1.62;}',
      '.mm-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}',
      '.mm-times{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);}',

      // 6. sessions
      '.mm-sessions{display:flex;flex-direction:column;gap:8px;margin-top:4px;}',
      '.mm-sess{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);padding:11px 14px;min-width:0;}',
      '.mm-shead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px;}',
      '.mm-stitle{font-size:13px;font-weight:560;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}',
      '.mm-ssnip{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;word-break:break-word;}',

      // empty / loading / error
      '.mm-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 20px;color:var(--dsw-alias-label-secondary);text-align:center;}',
      '.mm-empty svg{color:var(--dsw-alias-label-tertiary);}',
      '.mm-empty .mm-e1{font-size:13px;font-weight:560;color:var(--dsw-alias-label-primary);}',
      '.mm-load{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:16px 2px;}',
      '.mm-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:mm-spin .7s linear infinite;flex:none;}',
      '.mm-skel{height:13px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-layer-2);animation:mm-pulse 1.2s ease infinite;margin:8px 0;}',
      '.mm-err{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--dsw-alias-state-error-primary);border-left-width:3px;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm,8px);padding:9px 12px;margin:8px 0 2px;animation:mm-fade .2s ease;}',
      '.mm-err svg{flex:none;color:var(--dsw-alias-state-error-primary);margin-top:2px;}',
      '.mm-err .mm-etitle{font-size:12.5px;font-weight:600;}',
      '.mm-err .mm-elist{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;word-break:break-word;}',
      '.mm-mono{font-variant-numeric:tabular-nums;}',
    ].join('\n');

    // Inject the stylesheet at FACTORY time, not inside apply().
    //
    // dsh-client-modules wraps the synchronous `factory(require)` call in
    //   const before = untaggedStyles();
    //   record = { exports: factory(...), styles: claimStyles(ownerId, before) }
    // where claimStyles() stamps `data-plugin=<id>` onto every `style:not([data-plugin])`
    // that appeared during that call. Anything appended later (from apply(), which cordis
    // runs afterwards) misses that window, so the tag is unclaimed and removed on unload.
    // Appending here is therefore the one placement this bundle shape officially supports;
    // it also means the page is styled the instant it mounts.
    //
    // `styles` is NOT a usable identifier here: that parameter only exists for the `harness`
    // dynamic-package form (`new Function('React','console','styles','host',…)`). A factory
    // bundle has only `require`, so document.head is the correct sink.
    const CSS_ID = 'dsh-memory-styles';
    try {
      if (typeof document !== 'undefined' && document.head && !document.getElementById(CSS_ID)) {
        const tag = document.createElement('style');
        tag.id = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    } catch (e) { /* no DOM (host-side import of this file): styles are client-only */ }

    // ------------------------------------------------------------- safe readers
    function num(v, d) {
      if (v === null || v === undefined || v === '') return d;
      const n = typeof v === 'number' ? v : Number(v);
      return (typeof n === 'number' && isFinite(n)) ? n : d;
    }
    function str(v, d) {
      const fallback = d === undefined ? '' : d;
      if (v === null || v === undefined) return fallback;
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return fallback;
    }
    function arr(v) { return Array.isArray(v) ? v : []; }
    function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
    function has(v) { return v !== null && v !== undefined && v !== ''; }
    // Timestamps: epoch milliseconds per CONTRACT.md. The helper also tolerates epoch seconds and
    // already-formatted strings, and formats in the panel's own locale (spec §6.9 formatTime).
    function clock(v) {
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v.trim())) return v;
      let n = Number(v);
      if (!isFinite(n)) return String(v);
      if (Math.abs(n) < 1e12) n = n * 1000;
      try { return new Date(n).toLocaleString('zh-CN', { hour12: false }); }
      catch (e) { try { return new Date(n).toLocaleString(); } catch (x) { return String(v); } }
    }
    function amount(v) {
      const n = num(v, null);
      if (n === null) return tt('common.none');
      try { return n.toLocaleString(); } catch (e) { return String(n); }
    }
    function pct(v) { return Math.max(0, Math.min(100, num(v, 0))); }
    function barTone(v) {
      const p = pct(v);
      if (p >= 95) return 'mm-err';
      if (p >= 80) return 'mm-warn';
      return 'mm-ok';
    }
    function shortId(v) { return str(v, '').slice(0, 8) || '?'; }
    // A memory entry may be a bare string or an object holding the text (spec §4.5).
    function entryText(e) {
      if (typeof e === 'string' || typeof e === 'number') return String(e);
      const o = obj(e);
      const v = o.text !== undefined ? o.text : (o.content !== undefined ? o.content : o.value);
      return str(v, '');
    }
    function entryIndex(e, i) { return num(obj(e).index, i); }

    // ------------------------------------------------------------- svg glyphs
    function svg(size, paths, extra) {
      const p = { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, focusable: false };
      if (extra) { for (const k in extra) p[k] = extra[k]; }
      return h('svg', p, ...paths);
    }
    function chipGlyph(size, extra) {
      return svg(size, [
        h('rect', { key: 'a', x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 2.2 }),
        h('rect', { key: 'b', x: 6.3, y: 6.3, width: 3.4, height: 3.4, rx: 1 }),
        h('path', { key: 'c', d: 'M6.3 1.6v1.6M9.7 1.6v1.6M6.3 12.8v1.6M9.7 12.8v1.6M1.6 6.3h1.6M1.6 9.7h1.6M12.8 6.3h1.6M12.8 9.7h1.6', strokeLinecap: 'round' }),
      ], extra);
    }
    const G = {
      memory: (size) => chipGlyph(size || 20),
      side: (size, extra) => chipGlyph(size || 16, extra),
      refresh: () => svg(14, [h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.65', strokeLinecap: 'round' }), h('path', { key: 'b', d: 'M13.4 1.8v3h-3', strokeLinecap: 'round', strokeLinejoin: 'round' })]),
      search: () => svg(14, [h('circle', { key: 'a', cx: 7, cy: 7, r: 4.4 }), h('path', { key: 'b', d: 'M10.4 10.4 13.2 13.2', strokeLinecap: 'round' })]),
      chevron: () => svg(10, [h('path', { key: 'a', d: 'M3.5 6 8 10.5 12.5 6', strokeLinecap: 'round', strokeLinejoin: 'round' })]),
      warn: () => svg(15, [h('path', { key: 'a', d: 'M8 2.2 14.2 13H1.8L8 2.2Z', strokeLinejoin: 'round' }), h('path', { key: 'b', d: 'M8 6.6v3.2', strokeLinecap: 'round' }), h('path', { key: 'c', d: 'M8 11.6h.01', strokeLinecap: 'round' })]),
      folder: () => svg(20, [h('path', { key: 'a', d: 'M2 5.4c0-.7.6-1.3 1.3-1.3h2.4l1.3 1.6h5.3c.7 0 1.3.6 1.3 1.3v4.6c0 .7-.6 1.3-1.3 1.3H3.3c-.7 0-1.3-.6-1.3-1.3V5.4Z', strokeLinejoin: 'round' })]),
      check: () => svg(13, [h('path', { key: 'a', d: 'M2.8 8.5 6 11.7l7.2-7.4', strokeLinecap: 'round', strokeLinejoin: 'round' })]),
      upvote: () => svg(13, [h('path', { key: 'a', d: 'M6.2 13.8H4.6a.8.8 0 0 1-.8-.8v-2.8a.8.8 0 0 1 .8-.8h1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }), h('path', { key: 'b', d: 'M6.2 9.4 8.4 4.2c.2-.5.8-.6 1.1-.3.3.3.3.7.1 1L8.9 7.6h3.2c.7 0 1.2.6 1.1 1.3l-.6 3c-.1.5-.5.9-1 .9H6.2', strokeLinecap: 'round', strokeLinejoin: 'round' })]),
      downvote: () => svg(13, [h('path', { key: 'a', d: 'M6.2 13.8H4.6a.8.8 0 0 1-.8-.8v-2.8a.8.8 0 0 1 .8-.8h1.6', strokeLinecap: 'round', strokeLinejoin: 'round', transform: 'translate(0 16) scale(1 -1)' }), h('path', { key: 'b', d: 'M6.2 9.4 8.4 4.2c.2-.5.8-.6 1.1-.3.3.3.3.7.1 1L8.9 7.6h3.2c.7 0 1.2.6 1.1 1.3l-.6 3c-.1.5-.5.9-1 .9H6.2', strokeLinecap: 'round', strokeLinejoin: 'round', transform: 'translate(0 16) scale(1 -1)' })]),
    };

    // ------------------------------------------------------- small components
    function Chip(props) {
      return h('span', {
        className: 'mm-chip' + (props.tone ? ' mm-' + props.tone : '') + (props.plain ? ' mm-plain' : ''),
        title: props.title || undefined,
      }, props.tone ? h('i', { className: 'mm-dot' }) : null, props.children);
    }
    function Btn(props) {
      return h('button', {
        type: 'button',
        className: 'mm-btn' + (props.variant ? ' mm-' + props.variant : ''),
        onClick: props.onClick || undefined,
        disabled: props.disabled ? true : undefined,
        title: props.title || undefined,
      }, props.icon || null, props.children);
    }
    function Panel(props) {
      return h('section', { className: 'mm-panel' },
        h('div', { className: 'mm-panel-head' },
          props.icon ? h('span', { className: 'mm-picon' }, props.icon) : null,
          h('h3', null, props.title),
          props.aside ? h('span', { className: 'mm-aside' }, props.aside) : null),
        h('div', { className: 'mm-panel-body' }, props.children));
    }
    function Stat(props) {
      return h('div', { className: 'mm-stat' },
        h('div', { className: 'mm-slabel' }, props.label),
        h('div', { className: 'mm-svalue' }, props.value),
        h('div', { className: 'mm-ssub' }, props.sub));
    }
    function Field(props) {
      return h('div', { className: 'mm-field' + (props.grow ? ' mm-grow' : '') },
        h('span', { className: 'mm-flabel' }, props.label),
        props.children);
    }
    function Select(props) {
      return h('span', { className: 'mm-selectwrap' },
        h('select', {
          className: 'mm-select',
          value: props.value,
          onChange: props.onChange,
          'aria-label': props.ariaLabel || undefined,
        }, props.children),
        G.chevron());
    }
    function Loading(props) {
      return h('div', { className: 'mm-load' }, h('i', { className: 'mm-spinner' }), props.text || tt('common.loading'));
    }
    function EmptyState(props) {
      return h('div', { className: 'mm-empty' }, props.icon || G.folder(),
        h('div', { className: 'mm-e1' }, props.title),
        props.hint ? h('div', null, props.hint) : null);
    }
    function ErrorStrip(props) {
      const list = arr(props.errors);
      if (list.length === 0) return null;
      return h('div', { className: 'mm-err' }, G.warn(),
        h('div', null,
          h('div', { className: 'mm-etitle' }, tt('err.title')),
          h('div', { className: 'mm-elist' }, list.map((e, i) => h('div', { key: 'e' + i }, str(e))))));
    }

    // ------------------------------------------------------------- data access
    function api(path, params) {
      const qs = [];
      const p = obj(params);
      for (const k in p) {
        const v = p[k];
        if (v === null || v === undefined || v === '') continue;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
      }
      return API + path + (qs.length ? '?' + qs.join('&') : '');
    }
    async function getJson(url) {
      if (typeof fetch !== 'function') throw new Error(tt('err.fetch'));
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res || res.ok !== true) throw new Error(url + ' → ' + str(res && res.status, 'network'));
      let data = null;
      try { data = await res.json(); } catch (e) { throw new Error(url + ' → ' + tt('err.badjson')); }
      if (data && data.ok === false) throw new Error(url + ' → ' + str(data.error, tt('err.fetch')));
      return data;
    }
    function message(e) {
      try { return str(e && (e.message || e), tt('err.fetch')); } catch (x) { return tt('err.fetch'); }
    }

    // ------------------------------------------------------------ region: header
    function Header(props) {
      return h('header', { className: 'mm-head' },
        h('span', { className: 'mm-logo' }, G.memory(20)),
        h('span', { className: 'mm-htxt' },
          h('span', { className: 'mm-tline' },
            h('span', { className: 'mm-title' }, tt('page.title')),
            h(Chip, { tone: 'brand' }, tt('page.badge')),
            h(Chip, { plain: true }, tt('page.readonly'))),
          h('span', { className: 'mm-sub' }, tt('page.subtitle'))),
        h('span', { className: 'mm-acts' },
          h(Btn, { onClick: props.onRefresh, disabled: props.busy, title: tt('act.refresh'), icon: h('span', { className: props.busy ? 'mm-spin' : undefined }, G.refresh()) },
            props.busy ? tt('act.refreshing') : tt('act.refresh'))));
    }

    // ------------------------------------------------------- region: statistics
    function StatCards(props) {
      const ov = obj(props.overview);
      const builtin = obj(ov.builtin);
      const providers = obj(ov.providers);
      const facts = obj(ov.facts);
      const embedding = obj(ov.embedding);
      const version = str(ov.version, '—');
      const embState = str(embedding.state, 'unavailable');
      const embLabel = embState === 'ready' ? tt('stat.embedReady')
        : embState === 'failed' ? tt('stat.embedFailed')
        : embState === 'loading' ? tt('stat.embedLoading')
        : tt('stat.embedOff');
      return h('div', { className: 'mm-stats' },
        h(Stat, { label: tt('stat.builtin'), value: amount(builtin.entries), sub: tt('stat.builtinSub') }),
        h(Stat, { label: tt('stat.providers'), value: amount(providers.enabled), sub: tt('stat.providersSub') }),
        h(Stat, { label: tt('stat.facts'), value: amount(facts.total), sub: tt('stat.factsSub', { n: amount(facts.shown) }) }),
        h(Stat, { label: tt('stat.snapshot'), value: str(clock(ov.snapshotAt), '—') || '—', sub: tt('stat.snapshotSub', { version }) }),
        h(Stat, { label: tt('stat.embed'), value: embLabel, sub: tt('stat.embedSub', { state: str(embedding.model, '—'), n: amount(embedding.vectorCount) }) }));
    }

    // ----------------------------------------------------------- region: events
    function EventsTimeline(props) {
      const evts = arr(obj(props.eventsState).events);
      const [open, setOpen] = React.useState(true);
      if (!evts.length) return null;
      return h('div', { className: 'mm-events' + (open ? ' mm-open' : ' mm-closed') },
        h('div', { className: 'mm-events-head', onClick: () => setOpen(!open) },
          G.chevron(),
          tt('events.timeline') + ' (' + evts.length + ')'),
        open ? evts.slice(0, 20).map((e, i) =>
          h('div', { key: i, className: 'mm-events-item' },
            h('span', { className: 'mm-events-time' },
              new Date(num(e.timestamp, 0)).toLocaleString()),
            h('span', { className: 'mm-events-text' }, str(e.content).slice(0, 80))))
        : null);
    }

    // ----------------------------------------------------------- region: filter
    function FilterPanel(props) {
      const f = obj(props.filters);
      const set = props.set;
      const submit = () => props.onApply();
      const onKey = (e) => { if (e && (e.key === 'Enter' || e.keyCode === 13)) submit(); };
      return h(Panel, { title: tt('filter.title') },
        h('div', { className: 'mm-filters' },
          h(Field, { label: tt('filter.search'), grow: true },
            h('div', { className: 'mm-search' }, G.search(),
              h('input', {
                className: 'mm-input',
                type: 'search',
                placeholder: tt('filter.search'),
                value: str(f.q),
                onChange: (e) => set({ q: str(e && e.target && e.target.value) }),
                onKeyDown: onKey,
              }))),
          h(Field, { label: tt('filter.category') },
            h(Select, {
              value: str(f.category), ariaLabel: tt('filter.category'),
              onChange: (e) => set({ category: str(e && e.target && e.target.value) }),
            },
              h('option', { value: '' }, tt('filter.allCategories')),
              arr(props.categories).map((c, i) => {
                const co = obj(c);
                const name = str(co.name, '');
                if (!name) return null;
                return h('option', { key: 'c' + i, value: name }, name + (has(co.count) ? ' (' + amount(co.count) + ')' : ''));
              }))),
          h(Field, { label: tt('filter.minTrust') },
            h(Select, {
              value: str(f.minTrust, '0'), ariaLabel: tt('filter.minTrust'),
              onChange: (e) => set({ minTrust: str(e && e.target && e.target.value, '0') }),
            },
              h('option', { value: '0' }, '0'),
              h('option', { value: '0.3' }, '0.3'),
              h('option', { value: '0.5' }, '0.5'),
              h('option', { value: '0.75' }, '0.75'))),
          h(Field, { label: tt('filter.limit') },
            h(Select, {
              value: str(f.limit, '50'), ariaLabel: tt('filter.limit'),
              onChange: (e) => set({ limit: str(e && e.target && e.target.value, '50') }),
            },
              h('option', { value: '50' }, '50'),
              h('option', { value: '100' }, '100'),
              h('option', { value: '500' }, '500'))),
          h(Btn, { variant: 'primary', onClick: submit, disabled: props.busy, icon: h('span', { className: props.busy ? 'mm-spin' : undefined }, G.check()) }, tt('filter.apply'))),
        h('div', { className: 'mm-note' }, tt('filter.hint')));
    }

    // --------------------------------------------------- region: built-in files
    function BuiltinFile(props) {
      const f = obj(props.file);
      const entries = arr(f.entries);
      const pe = pct(f.percent);
      // 可用/不可用 follows the file on disk (spec §4.4: the badge is store.exists); `available` is
      // only the fallback for a payload that carries that flag instead.
      const available = typeof f.exists === 'boolean' ? f.exists === true : f.available === true;
      return h('div', { className: 'mm-file' },
        h('div', { className: 'mm-fhead' },
          h('span', { className: 'mm-fname' }, str(f.label, str(f.key, '—'))),
          h(Chip, { plain: true }, str(f.fileName, '—')),
          available ? h(Chip, { tone: 'ok' }, tt('builtin.available')) : h(Chip, { tone: 'err' }, tt('builtin.unavailable'))),
        h('div', { className: 'mm-fmeta' },
          h('div', { className: 'mm-frow' },
            h('span', null, tt('builtin.chars', { chars: amount(f.chars), budget: amount(f.budget) })),
            h('span', { className: 'mm-chip mm-plain mm-mono' }, tt('builtin.used', { percent: String(Math.floor(pe)) })),
            h('span', { className: 'mm-chip mm-plain' }, tt('builtin.entries', { n: amount(entries.length) }))),
          h('div', null, has(f.mtime) ? tt('builtin.mtime', { t: clock(f.mtime) }) : tt('builtin.never')),
          h('div', { className: 'mm-bar ' + barTone(pe) }, h('i', { style: { width: pe + '%' } })),
          has(f.path) ? h('div', null, h('span', { className: 'mm-code', title: str(f.path) }, str(f.path))) : null),
        entries.length === 0
          ? h(EmptyState, { title: tt('builtin.empty') })
          : h('div', { className: 'mm-entries' }, entries.map((e, i) => {
            const idx = entryIndex(e, i);
            return h('div', { key: 'en' + i, className: 'mm-entry' },
              h('span', { className: 'mm-idx' }, '#' + String(idx + 1)),
              h('span', { className: 'mm-etext' }, entryText(e)));
          })));
    }
    function BuiltinPanel(props) {
      const files = arr(props.builtin && props.builtin.files);
      return h(Panel, {
        title: tt('builtin.title'),
        aside: files.length ? tt('builtin.fileCount', { n: amount(files.length) }) : null,
      },
        props.loading ? h(Loading, null)
          : files.length === 0 ? h(EmptyState, { title: tt('builtin.none') })
            : h('div', { className: 'mm-files' }, files.map((f, i) => h(BuiltinFile, { key: 'f' + i, file: f }))));
    }

    // ------------------------------------------------- region: providers + facts
    function FactCard(props) {
      const fact = obj(props.fact);
      const tags = arr(fact.tags);
      const trust = num(fact.trust, 0);
      return h('article', { className: 'mm-fact' },
        h('div', { className: 'mm-fhead2' },
          h('span', { className: 'mm-fid' }, tt('fact.id', { id: shortId(fact.id) })),
          h(Chip, { plain: true, tone: 'brand' }, str(fact.category, 'general')),
          h(Chip, { plain: true, tone: trust >= 0.6 ? 'ok' : undefined }, tt('fact.trust', { v: trust.toFixed(3) })),
          h(Chip, { plain: true }, tt('fact.searched', { n: amount(fact.searchCount) })),
          h('button', {
            type: 'button',
            className: 'mm-chip mm-chipbtn mm-plain' + (num(fact.helpfulCount, 0) > 0 ? ' mm-ok' : ''),
            title: tt('fact.helpful', { n: amount(fact.helpfulCount) }),
            onClick: () => props.onHelpful(str(fact.id)),
          }, G.upvote(), tt('fact.helpful', { n: amount(fact.helpfulCount) })),
          h('button', {
            type: 'button',
            className: 'mm-chip mm-chipbtn mm-plain',
            title: tt('fact.downvote'),
            onClick: () => props.onDownvote ? props.onDownvote(str(fact.id)) : null,
          }, G.downvote(), tt('fact.downvote'))),
        h('div', { className: 'mm-fcontent' }, str(fact.content, '')),
        tags.length ? h('div', { className: 'mm-tags' }, tags.map((t, i) => h(Chip, { key: 't' + i, plain: true }, '#' + str(t)))) : null,
        h('div', { className: 'mm-times' },
          has(fact.updatedAt) ? h('span', null, tt('fact.updated', { t: clock(fact.updatedAt) })) : null,
          has(fact.createdAt) ? h('span', null, tt('fact.created', { t: clock(fact.createdAt) })) : null));
    }
    function ProviderCard(props) {
      const p = obj(props.provider);
      const [open, setOpen] = React.useState(true);
      const cats = arr(p.categories);
      return h('div', { className: 'mm-prov' },
        h('div', { className: 'mm-phead' },
          h('span', { className: 'mm-pname' }, str(p.label, str(p.id, '—'))),
          p.configured === false ? null : h(Chip, { tone: 'ok' }, tt('providers.configured')),
          p.available === false ? h(Chip, { tone: 'err' }, tt('providers.unavailable')) : h(Chip, { tone: 'ok' }, tt('providers.available'))),
        has(p.path) ? h('div', null, h('span', { className: 'mm-code', title: str(p.path) }, str(p.path))) : null,
        h('div', { className: 'mm-counters' },
          h('div', { className: 'mm-counter' }, h('div', { className: 'mm-cval' }, amount(p.facts)), h('div', { className: 'mm-clabel' }, tt('providers.facts'))),
          h('div', { className: 'mm-counter' }, h('div', { className: 'mm-cval' }, amount(p.shown)), h('div', { className: 'mm-clabel' }, tt('providers.shown'))),
          h('div', { className: 'mm-counter' }, h('div', { className: 'mm-cval' }, amount(p.entities)), h('div', { className: 'mm-clabel' }, tt('providers.entities'))),
          h('div', { className: 'mm-counter' }, h('div', { className: 'mm-cval' }, amount(p.stores)), h('div', { className: 'mm-clabel' }, tt('providers.stores')))),
        h('div', { className: 'mm-frow' },
          h(Btn, { variant: 'ghost', onClick: () => setOpen(!open) }, open ? tt('providers.overviewHide') : tt('providers.overview'))),
        open ? h('div', { className: 'mm-ov' },
          h('div', { className: 'mm-ovrow' }, h('span', { className: 'mm-ovk' }, tt('providers.backend')), h('span', { className: 'mm-ovv' }, str(p.backend, tt('common.none')))),
          h('div', { className: 'mm-ovrow' }, h('span', { className: 'mm-ovk' }, tt('providers.relations')), h('span', { className: 'mm-ovv' }, amount(p.relations))),
          h('div', { className: 'mm-ovrow' }, h('span', { className: 'mm-ovk' }, tt('providers.snapshot')), h('span', { className: 'mm-ovv' }, str(clock(p.snapshotAt), tt('common.none')) || tt('common.none'))),
          h('div', { className: 'mm-ovrow' }, h('span', { className: 'mm-ovk' }, tt('providers.categories')),
            h('span', { className: 'mm-ovv', title: cats.map((c) => str(obj(c).name, '')).filter(Boolean).join(', ') },
              cats.length ? cats.map((c) => str(obj(c).name, '')).filter(Boolean).join(' · ') : tt('common.none')))) : null);
    }
    function ProvidersPanel(props) {
      const providers = arr(props.providers && props.providers.providers);
      const factsState = obj(props.factsState);
      const facts = arr(factsState.facts);
      const total = num(factsState.total, facts.length);
      const filtered = num(factsState.filtered, facts.length);
      return h(Panel, {
        title: tt('providers.title'),
        aside: h('span', null, tt('facts.count', { n: amount(total) }) + (filtered !== total ? ' · ' + tt('facts.filtered', { n: amount(filtered) }) : '')),
      },
        props.loading ? h(Loading, null)
          : providers.length === 0 ? h(EmptyState, { title: tt('providers.none') })
            : providers.map((p, i) => h(ProviderCard, { key: 'p' + i, provider: p })),
        // No sub-heading here: the reference panel puts the fact cards straight under the provider
        // card, and the panel header already carries `事实 N` in its aside. An extra <h3> read as a
        // seventh region and broke parity with the screenshot.
        props.factsLoading ? h(Loading, null)
          : facts.length === 0 ? h(EmptyState, { title: tt('facts.empty') })
            : h('div', { className: 'mm-facts' }, facts.map((f, i) => h(FactCard, { key: 'fa' + i, fact: f, onHelpful: props.onHelpful, onDownvote: props.onDownvote }))));
    }

    // ---------------------------------------------------------- region: sessions
    function SessionsPanel(props) {
      const s = obj(props.sessions);
      const q = obj(props.query);
      const set = props.set;
      const hits = arr(s.sessions);
      const sources = arr(s.sources);
      const submit = () => props.onSearch();
      const onKey = (e) => { if (e && (e.key === 'Enter' || e.keyCode === 13)) submit(); };
      return h(Panel, { title: tt('sessions.title'), aside: q.note ? str(q.note) : null },
        h('div', { className: 'mm-filters' },
          h(Field, { label: tt('sessions.fieldLabel'), grow: true },
            h('div', { className: 'mm-search' }, G.search(),
              h('input', {
                className: 'mm-input', type: 'search', placeholder: tt('sessions.search'),
                value: str(q.q), onChange: (e) => set({ q: str(e && e.target && e.target.value) }), onKeyDown: onKey,
              }))),
          h(Field, { label: tt('sessions.source') },
            h(Select, {
              value: str(q.source), ariaLabel: tt('sessions.source'),
              onChange: (e) => set({ source: str(e && e.target && e.target.value) }),
            },
              h('option', { value: '' }, tt('sessions.allSources')),
              sources.map((sc, i) => h('option', { key: 's' + i, value: str(sc) }, str(sc))))),
          h(Field, { label: tt('sessions.sort') },
            h(Select, {
              value: str(q.sort, 'recent'), ariaLabel: tt('sessions.sort'),
              onChange: (e) => set({ sort: str(e && e.target && e.target.value, 'recent') }),
            },
              h('option', { value: 'recent' }, tt('sessions.recent')),
              h('option', { value: 'oldest' }, tt('sessions.oldest')))),
          h(Btn, { onClick: submit, disabled: props.busy, icon: h('span', { className: props.busy ? 'mm-spin' : undefined }, G.search()) }, tt('sessions.go'))),
        h('div', { className: 'mm-note' }, tt('sessions.hint')),
        props.loading ? h(Loading, null)
          : hits.length === 0 ? h(EmptyState, { title: tt('sessions.empty') })
            : h('div', { className: 'mm-sessions' }, hits.map((hit, i) => {
              const ho = obj(hit);
              return h('div', { key: 'h' + i, className: 'mm-sess' },
                h('div', { className: 'mm-shead' },
                  h('span', { className: 'mm-stitle', title: str(ho.title) }, str(ho.title, str(ho.id, '—'))),
                  has(ho.source) ? h(Chip, { plain: true, tone: 'brand' }, str(ho.source)) : null,
                  has(ho.matches) ? h(Chip, { plain: true }, tt('sessions.matches', { n: amount(ho.matches) })) : null,
                  has(ho.updatedAt) ? h('span', { className: 'mm-aside' }, tt('sessions.updated', { t: clock(ho.updatedAt) })) : null),
                h('div', { className: 'mm-ssnip' }, str(ho.snippet, '')));
            })));
    }

    // ------------------------------------------------------------------ page
    function Page() {
      const [overview, setOverview] = React.useState(null);
      const [builtin, setBuiltin] = React.useState(null);
      const [factsState, setFactsState] = React.useState(null);
      const [providersState, setProvidersState] = React.useState(null);
      const [sessionsState, setSessionsState] = React.useState(null);
      const [filters, setFilters] = React.useState({ q: '', category: '', minTrust: '0', limit: '50' });
      const [sessionQuery, setSessionQuery] = React.useState({ q: '', source: '', sort: 'recent' });
      const [errors, setErrors] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [eventsState, setEventsState] = React.useState(null);

      const report = (label, err) => {
        const msg = label + ': ' + message(err);
        setErrors((prev) => (arr(prev).indexOf(msg) >= 0 ? prev : arr(prev).concat([msg])));
      };
      const clearError = (label) => {
        setErrors((prev) => arr(prev).filter((e) => str(e).indexOf(label + ':') !== 0));
      };

      const loadOverview = async () => {
        try { const d = await getJson(api('/overview')); setOverview(obj(d)); clearError('overview'); }
        catch (e) { setOverview({}); report('overview', e); }
      };
      const loadEvents = async () => {
        try { const d = await getJson(api('/events')); setEventsState({ events: arr(d.events) }); clearError('events'); }
        catch (e) { setEventsState({ events: [] }); }
      };
      const loadBuiltin = async () => {
        try {
          const files = arr(obj(await getJson(api('/builtin'))).files);
          setBuiltin({ files }); clearError('builtin');
        } catch (e) { setBuiltin({ files: [] }); report('builtin', e); }
      };
      const loadFacts = async (f) => {
        const use = obj(f || filters);
        try {
          const d = obj(await getJson(api('/facts', { q: use.q, category: use.category, minTrust: use.minTrust, limit: use.limit })));
          setFactsState({ facts: arr(d.facts), total: num(d.total, 0), filtered: num(d.filtered, arr(d.facts).length), categories: arr(d.categories) });
          clearError('facts');
        } catch (e) {
          setFactsState((prev) => ({ facts: [], total: 0, filtered: 0, categories: arr(obj(prev).categories) }));
          report('facts', e);
        }
      };
      const loadProviders = async () => {
        try {
          const d = obj(await getJson(api('/providers')));
          setProvidersState({ providers: arr(d.providers) });
          clearError('providers');
        } catch (e) {
          // Fall back to the provider items that /overview already carries.
          const items = arr(obj(obj(overview).providers).items);
          setProvidersState({ providers: items });
          report('providers', e);
        }
      };
      const loadSessions = async (q) => {
        const use = obj(q || sessionQuery);
        try {
          const d = obj(await getJson(api('/sessions', { q: use.q, source: use.source, sort: use.sort })));
          setSessionsState({ sessions: arr(d.sessions), sources: arr(d.sources), note: str(d.note) });
          clearError('sessions');
        } catch (e) { setSessionsState({ sessions: [], sources: [] }); report('sessions', e); }
      };

      React.useEffect(() => {
        loadOverview(); loadBuiltin(); loadProviders(); loadFacts(filters); loadSessions(sessionQuery); loadEvents();
      }, []);

      const applyFilters = () => { loadFacts(filters); };
      const searchSessions = () => { loadSessions(sessionQuery); };
      const refresh = () => {
        setBusy(true);
        setErrors([]);
        const post = (typeof fetch === 'function')
          ? fetch(api('/refresh'), { method: 'POST', credentials: 'same-origin' }).catch(() => null)
          : Promise.resolve(null);
        Promise.resolve(post).then(() => Promise.all([
          loadOverview(), loadBuiltin(), loadProviders(), loadFacts(filters), loadSessions(sessionQuery), loadEvents(),
        ])).catch(() => {}).then(() => setBusy(false));
      };
      const markHelpful = (id) => {
        if (!id || typeof fetch !== 'function') return;
        let url = '';
        try { url = api('/facts/' + encodeURIComponent(id) + '/helpful'); } catch (e) { return; }
        try {
          fetch(url, { method: 'POST', credentials: 'same-origin' }).then((res) => {
            if (!res || res.ok !== true) return; // route absent → degrade silently
            setFactsState((prev) => {
              if (!prev) return prev;
              const next = arr(prev.facts).map((f) => (str(obj(f).id) === id
                ? Object.assign({}, obj(f), { helpfulCount: num(obj(f).helpfulCount, 0) + 1 })
                : f));
              return Object.assign({}, prev, { facts: next });
            });
          }).catch(() => {});
        } catch (e) { /* silent by contract */ }
      };
      const markDownvote = (id) => {
        if (!id || typeof fetch !== 'function') return;
        try {
          fetch(api('/feedback'), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ factId: id, vote: 'down' }),
          }).then((res) => {
            if (!res || !res.ok) return;
            setFactsState((prev) => {
              if (!prev) return prev;
              const next = arr(prev.facts).map((f) => (str(obj(f).id) === id
                ? Object.assign({}, obj(f), { trust: Math.max(0, num(obj(f).trust, 0.5) - 0.15) })
                : f));
              return Object.assign({}, prev, { facts: next });
            });
          }).catch(() => {});
        } catch (e) { /* silent */ }
      };

      const ov = obj(overview);
      const providers = arr(obj(providersState).providers);
      // The category list normally rides on /facts; fall back to the provider's own categories.
      const ownCategories = arr(obj(factsState).categories);
      const categories = ownCategories.length ? ownCategories : arr(obj(providers[0]).categories);

      return h('div', { className: 'mm-view' },
        h(Header, { busy, onRefresh: refresh }),
        h('div', { className: 'mm-body' },
          h('div', { className: 'mm-main' },
            h(ErrorStrip, { errors }),
            h('div', { style: { marginTop: 4 } }, h(StatCards, { overview: ov })),
            h(EventsTimeline, { eventsState }),
            h('div', { className: 'mm-cols' },
              h('div', { className: 'mm-col' },
                h(FilterPanel, {
                  filters, set: (patch) => setFilters((prev) => Object.assign({}, obj(prev), obj(patch))),
                  categories,
                  busy, onApply: applyFilters,
                }),
                h(BuiltinPanel, { builtin, loading: builtin === null })),
              h('div', { className: 'mm-col' },
                h(ProvidersPanel, {
                  providers: providersState, factsState, onHelpful: markHelpful, onDownvote: markDownvote,
                  loading: providersState === null, factsLoading: factsState === null,
                }),
                h(SessionsPanel, {
                  sessions: sessionsState,
                  query: sessionQuery,
                  set: (patch) => setSessionQuery((prev) => Object.assign({}, obj(prev), obj(patch))),
                  loading: sessionsState === null, busy, onSearch: searchSessions,
                }))))));
    }

    // ------------------------------------------------------ sidebar entry icon
    function Icon(props) {
      return G.side((props && props.size) || 16, { 'data-dsh-panel-entry': PANEL_ID });
    }

    return {
      // `styles` is deliberately NOT declared: a factory-form bundle cannot receive the
      // `styles` closure parameter, and we inject through document.head instead (see the
      // CSS block above). `locale` IS declared so ctx.locale.register() is permitted — an
      // undeclared service read throws a teaching error via rejectGuard.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const host = obj(ctx);

        // Styles were already appended during factory evaluation (see the CSS block above),
        // which is the only window dsh-client-modules' claimStyles() observes. This is a
        // belt-and-braces re-run for hosts that reload the module table without re-running
        // the factory; it is idempotent thanks to the CSS_ID check.
        const installStyles = () => {
          try {
            if (typeof document === 'undefined' || !document.head) return;
            if (document.getElementById(CSS_ID)) return;
            const node = document.createElement('style');
            node.id = CSS_ID;
            node.textContent = CSS;
            document.head.appendChild(node);
          } catch (e) { /* non-DOM host */ }
        };
        installStyles();
        try {
          if (host.styles && typeof host.styles.insert === 'function') host.styles.insert(CSS);
        } catch (e) { /* not declared for this bundle shape — the head tag above is authoritative */ }

        // `locale` is gated the same way as `styles`: reading an undeclared service throws.
        // Wrap every host-service read in its own guarded accessor so one missing service
        // can never take the whole apply() down or skip the others.
        const service = (read) => { try { return read(); } catch (e) { return undefined; } };

        const bindLocale = () => {
          try {
            const locale = service(() => host.locale);
            if (!locale || typeof locale.register !== 'function') return;
            locale.register(NS, { zh: DICTS.zh, en: DICTS.en });
            const bound = typeof locale.bind === 'function' ? locale.bind(NS) : null;
            if (typeof bound !== 'function') return;
            tt = (key, vars) => {
              try {
                let v = bound(key);
                if (v === undefined || v === null) v = DICTS.zh[key] != null ? DICTS.zh[key] : (DICTS.en[key] != null ? DICTS.en[key] : key);
                if (vars) v = String(v).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
                return v;
              } catch (e) { return DICTS.zh[key] != null ? DICTS.zh[key] : key; }
            };
          } catch (e) { /* keep the built-in fallback formatter */ }
        };
        const effect = service(() => host.effect);
        if (typeof effect === 'function') {
          try { effect(() => { bindLocale(); return () => {}; }, 'dsh-memory: locale'); } catch (e) { bindLocale(); }
        } else { bindLocale(); }

        const registerSlots = () => {
          const disposers = [];
          // `slots` IS declared in our inject list, so this read is legal — but it still goes
          // through `service()` so a boot race (service not yet provided) degrades instead of
          // throwing and leaving the page without its sidebar entry.
          const slots = service(() => host.slots);
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return disposers;
          try {
            disposers.push(slots.inject('sidebar.panellist', () => slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: ORDER, label: () => tt('entry.label'),
            }, Icon)));
          } catch (e) { /* slot unavailable */ }
          try {
            disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page)));
          } catch (e) { /* slot unavailable */ }
          return disposers;
        };

        if (typeof effect === 'function') {
          try {
            effect(() => {
              const disposers = registerSlots();
              return () => { for (const d of disposers) { try { if (typeof d === 'function') d(); } catch (e) { /* noop */ } } };
            }, 'dsh-memory: slots');
          } catch (e) { registerSlots(); }
        } else { registerSlots(); }
      },
    };
  },
});

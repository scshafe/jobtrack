'use strict';

// The whole stylesheet, inlined into every document.
//
// It lives alone because it is the one part of the surface with no JavaScript
// semantics at all: a single template literal of CSS. Two structural rules the
// layout depends on, pinned by test/web-navigation.test.js:
//
//   - the document never scrolls (.app-viewport sets overflow:hidden); the
//     results region is the only scroller, and every flex ancestor of it sets
//     min-height:0 or a second scrollbar appears;
//   - this FILE must contain exactly two backticks -- the delimiters of the
//     CSS literal below. A stray one terminates the string early and the
//     remaining CSS becomes executable JS, which 500s every page. Keep the
//     count at two and never write a backtick in these comments.

function baseStyles() {
  return `
    :root { color-scheme: dark; --space-3xs:2px; --space-2xs:4px; --space-xs:6px; --space-sm:8px; --space-md:12px; --space-lg:16px; --space-xl:24px; --space-2xl:32px; --bg:#0a0d13; --surface:#11151d; --surface-2:#151b25; --card:var(--surface); --ink:#e8eef6; --muted:#95a3b5; --faint:#6a7787; --line:#273141; --line-soft:#1a212c; --accent:#5cc8f5; --accent-soft:color-mix(in srgb,var(--accent),transparent 88%); --good:#54d167; --warn:#e3b341; --danger:#ff7b72; --stage:#7dd3fc; --package:#7ee0a3; --r:9px; --r-sm:6px; --r-xs:4px; }
    @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--surface-2:#f7f9fb;--card:var(--surface);--ink:#18212d;--muted:#526174;--faint:#6f7d8e;--line:#d9e0e8;--line-soft:#e9eef3;--accent:#087da8;--good:#147d36;--warn:#946200;--danger:#b42318;--stage:#0369a1;--package:#15803d}}
    * { box-sizing: border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
    ::selection { background:color-mix(in srgb,var(--accent),transparent 70%); }
    a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
    :focus-visible { outline:var(--space-3xs) solid var(--accent); outline-offset:var(--space-3xs); border-radius:var(--r-xs); }
    code,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    main,.shell { width:min(1280px,calc(100vw - var(--space-2xl))); margin:var(--space-xl) auto 64px; }
    header,.page-hero { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--space-xl); align-items:end; margin-bottom:var(--space-lg); padding-bottom:var(--space-lg); border-bottom:1px solid var(--line); }
    .page-hero > div:first-child { flex:1 1 560px; min-width:0; }
    .page-hero > div:last-child { flex:0 1 600px; min-width:0; margin-left:auto; }
    h1 { font-size:clamp(1.75rem,4vw,2.7rem); line-height:1; letter-spacing:-.045em; margin:0; }
    h2 { letter-spacing:-.02em; } p { line-height:1.55; }
    .kicker { color:var(--faint); font:700 .68rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.18em; margin:0 0 var(--space-sm); text-transform:uppercase; }
    .summary,.activity,.role { color:var(--muted); font-size:.84rem; margin-top:var(--space-xs); }
    .result-count { color:var(--faint); font-size:.76rem; margin:var(--space-sm) 0 0; text-align:right; }
    .nav { display:flex; flex-wrap:wrap; gap:var(--space-2xs); justify-content:flex-end; }
    .nav a { color:var(--muted); border:1px solid var(--line); border-radius:var(--r-sm); padding:var(--space-2xs) var(--space-sm); font-size:.78rem; background:var(--surface); }
    .nav a:hover { color:var(--accent); border-color:var(--accent); text-decoration:none; }
    /* ---- app shell: header + pinned filter strip + one scrolling region ----
       The document does not scroll. .app-viewport is the full-height flex
       column; .app-main is the only flex child that may grow, and every
       ancestor of the scroller sets min-height:0 so it can actually shrink.
       NOTE: this block is inside a JS template literal — never use a backtick
       in these comments, it terminates the string. */
    .app-viewport { height:100dvh; overflow:hidden; display:flex; flex-direction:column; }
    .app-main { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; width:min(1600px,100%); margin:0 auto; padding:0 var(--space-lg); }
    /* Detail and profile pages have no filter strip or results table, so MAIN
       itself is the scroller. Reading width comes from padding rather than
       width + auto margins, so the scrollbar sits at the viewport edge instead
       of floating in from the centred column. */
    main.app-doc { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; scrollbar-gutter:stable; width:100%; max-width:none; margin:0; padding:var(--space-xl) max(var(--space-lg),calc((100% - 1280px) / 2)) 64px; }
    .results-region { flex:1 1 auto; min-height:0; overflow:auto; scrollbar-gutter:stable; padding-bottom:var(--space-xl); }
    /* Header: a sibling of the scroller, so it is pinned by construction and
       needs no position:fixed and no scroll listener. */
    .app-header { flex:0 0 auto; display:flex; align-items:center; gap:var(--space-lg); height:52px; padding:0 var(--space-lg); border-bottom:1px solid var(--line); background:var(--surface); }
    .brand { color:var(--ink); font:700 .95rem/1 var(--font-body,inherit); letter-spacing:-.01em; text-decoration:none; white-space:nowrap; }
    .brand:hover { color:var(--accent); text-decoration:none; }
    .brand.is-active { color:var(--accent); }
    .header-note { flex:0 0 auto; margin-left:var(--space-sm); padding:var(--space-3xs) var(--space-xs); border:1px solid var(--line); border-radius:var(--r-xs); color:var(--faint); font:600 .62rem/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; text-transform:uppercase; }
    .header-nav { display:flex; align-items:center; gap:var(--space-3xs); margin-left:auto; min-width:0; overflow-x:auto; scrollbar-width:none; }
    .header-nav::-webkit-scrollbar { display:none; }
    /* shadcn button language: 32px control height, md radius, medium weight,
       transparent by default, muted foreground, subtle hover fill. */
    .hbtn { display:inline-flex; align-items:center; height:32px; padding:0 var(--space-md); border:1px solid transparent; border-radius:var(--r-sm); background:transparent; color:var(--muted); font:500 .8rem/1 var(--font-body,inherit); white-space:nowrap; text-decoration:none; cursor:pointer; }
    .hbtn:hover { background:var(--surface-2); color:var(--ink); text-decoration:none; }
    .hbtn.is-active { background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent),transparent 60%); color:var(--accent); }
    .hbtn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .hbtn-primary { border-color:var(--line); background:var(--surface-2); color:var(--ink); }
    .hbtn-primary:hover { border-color:var(--accent); color:var(--accent); }
    /* Page bar: title + count on one fixed-height row. */
    .toolbar { flex:0 0 auto; display:flex; align-items:center; gap:var(--space-sm); border-bottom:1px solid var(--line); }
    .toolbar .filter-bar { flex:1 1 auto; min-width:0; border-bottom:0; }
    .toolbar .result-count { flex:0 0 auto; margin:0; white-space:nowrap; }
    .toolbar-title { flex:0 0 auto; margin:0; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.85rem; font-weight:600; line-height:1; }
    /* Filter strip: the second pinned header. Fixed height; overflow scrolls
       sideways so the region can never grow and steal the table's space. */
    .filter-bar { flex:0 0 auto; margin:0; padding:0; border-bottom:1px solid var(--line); }
    .filter-strip { display:flex; align-items:center; gap:var(--space-2xs); height:40px; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
    .filter-strip::-webkit-scrollbar { display:none; }
    .filter-control { height:26px; min-width:0; max-width:170px; padding:0 var(--space-xs); border:1px solid var(--line); border-radius:var(--r-xs); background:var(--surface); color:var(--ink); font:400 .74rem/1 var(--font-body,inherit); }
    .filter-control:focus-visible { outline:2px solid var(--accent); outline-offset:-1px; }
    .filter-search { flex:0 1 260px; min-width:150px; max-width:320px; }
    .filter-strip .active-filter { flex:0 0 auto; }
    .filter-strip .hbtn { height:26px; padding:0 var(--space-sm); font-size:.74rem; }
    /* Table region: header row sticks to the top of the scroller. Sticky cells
       need border-collapse:separate or their borders vanish while scrolling. */
    .results-region table { border-collapse:separate; border-spacing:0; }
    .results-region thead th { position:sticky; top:0; z-index:2; background:var(--surface-2); }
    .results-region .table-card { overflow:visible; }
    .results-region .table-scroll { overflow:visible; }
    /* CSS-only profile tabs. With no :target every section shows (the classic
       stacked view); target one and only it shows. Browsers without :has()
       fall back to showing everything, which is the pre-tabs behaviour and
       never a broken page. */
    .profile-shell[data-jt-tabs="css"]:has(.profile-section:target) .profile-section { display:none; }
    .profile-shell[data-jt-tabs="css"]:has(.profile-section:target) .profile-section:target { display:block; }
    .profile-section:target > .section-head { border-color:var(--accent); }
    .skip-link { position:fixed; z-index:10; left:var(--space-md); top:var(--space-sm); transform:translateY(-180%); padding:var(--space-sm) var(--space-md); background:var(--accent); color:var(--bg); border-radius:var(--r-sm); }
    .skip-link:focus { transform:none; }
    .filter-panel { margin:0 0 var(--space-lg); padding:var(--space-md); border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
    .filter-grid { display:grid; grid-template-columns:minmax(190px,1.5fr) repeat(5,minmax(130px,1fr)); gap:var(--space-sm); align-items:start; }
    .filter-field { display:grid; gap:var(--space-2xs); min-width:0; color:var(--faint); font:700 .63rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.1em; text-transform:uppercase; }
    input,select,button { width:100%; min-height:36px; border:1px solid var(--line); border-radius:var(--r-sm); background:var(--surface-2); color:var(--ink); padding:var(--space-xs) var(--space-sm); font:inherit; letter-spacing:normal; text-transform:none; }
    select[multiple] { min-height:78px; } button { width:auto; cursor:pointer; border-color:color-mix(in srgb,var(--accent),transparent 40%); background:var(--accent-soft); color:var(--accent); font-weight:700; }
    button:hover { border-color:var(--accent); }
    .filter-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-sm); margin-top:var(--space-sm); }
    .filter-actions a { font-size:.82rem; } .filter-help { margin-left:auto; color:var(--faint); font-size:.75rem; }
    .active-filters { display:flex; flex-wrap:wrap; gap:var(--space-2xs); margin-top:var(--space-sm); padding-top:var(--space-sm); border-top:1px solid var(--line-soft); }
    .active-filter { padding:var(--space-3xs) var(--space-xs); border:1px solid color-mix(in srgb,var(--accent),transparent 55%); border-radius:var(--r-xs); background:var(--accent-soft); color:var(--accent); font-size:.72rem; }
    .active-filter:hover { text-decoration:none; border-color:var(--accent); }
    .coverage-note,.privacy-note { margin:0 0 var(--space-lg); padding:var(--space-sm) var(--space-md); color:var(--muted); font-size:.79rem; border-left:var(--space-3xs) solid var(--warn); background:color-mix(in srgb,var(--warn),transparent 94%); }
    .privacy-note { border-left-color:var(--danger); background:color-mix(in srgb,var(--danger),transparent 95%); }
    .card,.opportunity-card,.panel { min-width:0; padding:var(--space-lg); background:var(--surface); border:1px solid var(--line); border-radius:var(--r); }
    .card:hover,.opportunity-card:hover { border-color:color-mix(in srgb,var(--accent),var(--line) 58%); }
    .card h2,.opportunity-card h2 { margin:var(--space-2xs) 0 var(--space-sm); font-size:1.05rem; } .card h2 a,.opportunity-card h2 a { color:var(--ink); }
    .card-grid,.grid,.detail,.stack { display:grid; gap:var(--space-sm); }
    .card-head { display:flex; justify-content:space-between; gap:var(--space-lg); }
    .table-card { padding:0; overflow:hidden; } .table-scroll { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:var(--space-md) var(--space-md); text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--faint); background:var(--surface-2); font:700 .64rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.11em; text-transform:uppercase; white-space:nowrap; }
    th a { color:inherit; } tbody tr:last-child td { border-bottom:0; }
    .status,.stage,.package,.pill,.tag,.chip { display:inline-flex; border:1px solid color-mix(in srgb,var(--accent),transparent 55%); border-radius:var(--r-xs); padding:var(--space-3xs) var(--space-xs); background:var(--accent-soft); color:var(--accent); font:700 .7rem/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:capitalize; }
    .stage { color:var(--stage); border-color:color-mix(in srgb,var(--stage),transparent 60%); background:color-mix(in srgb,var(--stage),transparent 91%); }
    .package,.pill { color:var(--package); border-color:color-mix(in srgb,var(--package),transparent 60%); background:color-mix(in srgb,var(--package),transparent 91%); }
    .pill-neutral,.tag { color:var(--muted); border-color:var(--line); background:var(--surface-2); }
    .tag-row,.tags,.chips,.readonly-strip { display:flex; flex-wrap:wrap; gap:var(--space-2xs); margin-top:var(--space-xs); }
    .readonly-strip span { border:1px solid var(--line); border-radius:var(--r-xs); padding:var(--space-3xs) var(--space-sm); color:var(--faint); font:normal .7rem ui-monospace,SFMono-Regular,Menlo,monospace; }
    .signal { margin-top:var(--space-xs); padding:var(--space-2xs) var(--space-xs); border:1px solid color-mix(in srgb,var(--warn),transparent 55%); border-radius:var(--r-sm); color:var(--warn); font-size:.72rem; background:color-mix(in srgb,var(--warn),transparent 93%); }
    .signal span { display:inline-grid; place-items:center; width:1.2em; height:1.2em; margin-right:var(--space-2xs); border-radius:50%; background:var(--warn); color:var(--bg); font-weight:900; }
    .signal-note { color:var(--accent); border-color:color-mix(in srgb,var(--accent),transparent 55%); background:var(--accent-soft); }
    .signal-note span { background:var(--accent); }
    .signal-good { color:var(--good); border-color:color-mix(in srgb,var(--good),transparent 55%); background:color-mix(in srgb,var(--good),transparent 93%); }
    .signal-good span { background:var(--good); }
    .warning { color:var(--warn); } .empty,.empty-panel { padding:var(--space-xl); border:1px dashed var(--line); border-radius:var(--r-sm); text-align:center; color:var(--faint); font-size:.82rem; background:var(--surface-2); }
    .empty { list-style:none; }
    .empty-message { margin:0; }
    .empty-command { margin:var(--space-sm) 0 0; }
    .empty-command code { display:inline-block; padding:var(--space-2xs) var(--space-sm); border:1px solid var(--line); border-radius:var(--r-xs); background:var(--surface); color:var(--muted); font-size:.76rem; overflow-wrap:anywhere; }
    .badge { display:inline-flex; border:1px solid var(--line); border-radius:var(--r-xs); padding:var(--space-3xs) var(--space-xs); background:var(--surface-2); color:var(--muted); font:700 .7rem/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:capitalize; }
    .badge-info { color:var(--accent); border-color:color-mix(in srgb,var(--accent),transparent 60%); background:color-mix(in srgb,var(--accent),transparent 91%); }
    .badge-ok { color:var(--good); border-color:color-mix(in srgb,var(--good),transparent 60%); background:color-mix(in srgb,var(--good),transparent 91%); }
    .badge-warning { color:var(--warn); border-color:color-mix(in srgb,var(--warn),transparent 60%); background:color-mix(in srgb,var(--warn),transparent 91%); }
    .badge-danger { color:var(--danger); border-color:color-mix(in srgb,var(--danger),transparent 60%); background:color-mix(in srgb,var(--danger),transparent 91%); }
    .technical { margin-top:var(--space-sm); border:1px solid var(--line-soft); border-radius:var(--r-sm); background:var(--surface-2); }
    .technical > summary { padding:var(--space-sm) var(--space-md); color:var(--muted); font-size:.78rem; cursor:pointer; list-style:revert; }
    .technical > summary:hover { color:var(--ink); }
    .technical > summary:focus-visible { outline:var(--space-3xs) solid var(--accent); outline-offset:var(--space-3xs); }
    .technical[open] > summary { border-bottom:1px solid var(--line-soft); }
    .technical .kv { padding:var(--space-md); }
    .profile-shell > .profile-tabs { position:static; flex:0 0 auto; margin:0; border:0; border-bottom:1px solid var(--line); border-radius:0; background:var(--surface); overflow-x:auto; flex-wrap:nowrap; scrollbar-width:none; }
    .profile-shell > .profile-tabs::-webkit-scrollbar { display:none; }
    .profile-shell > .profile-tabs a { white-space:nowrap; }
    .section-index { position:sticky; top:var(--space-sm); z-index:2; display:flex; flex-wrap:wrap; gap:var(--space-2xs); margin:0 0 var(--space-md); padding:var(--space-xs); border:1px solid var(--line); border-radius:var(--r); background:color-mix(in srgb,var(--surface),transparent 4%); }
    .section-index a { display:flex; gap:var(--space-sm); align-items:center; padding:var(--space-xs) var(--space-sm); border-radius:var(--r-sm); color:var(--muted); font-size:.78rem; }
    .section-index a:hover,.section-index a:focus { color:var(--ink); background:var(--surface-2); text-decoration:none; }
    .profile-tabs a.active { color:var(--ink); background:var(--surface-2); box-shadow:inset 0 -var(--space-3xs) 0 var(--accent, currentColor); font-weight:600; }
    .work-outline { margin-top:var(--space-sm); }
    .work-outline > summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
    .detail-outline { margin:var(--space-xs) 0 0 var(--space-3xs); padding-left:var(--space-lg); }
    .detail-outline li { margin:var(--space-3xs) 0; }
    .outline-id { color:var(--muted); font-size:.72rem; margin-right:var(--space-2xs); }
    .section-index code { color:var(--faint); }
    .profile-sections { display:grid; gap:var(--space-md); }
    /* Profile is a single column end to end. Two-across cards made the reading
       order ambiguous (down, or across?) exactly where chronology is the point,
       and the key/value grids inside an entry split one record's facts over
       two or three columns. Scoped to the profile shell so the application
       workspace, which reads as a dashboard, keeps its denser grids. */
    .profile-shell .entry-grid { grid-template-columns:minmax(0,1fr); }
    .profile-shell .kv, .profile-shell .meta { grid-template-columns:minmax(0,1fr); }
    .profile-section { scroll-margin-top:72px; border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--surface); }
    .profile-section:target { border-color:var(--accent); box-shadow:0 0 0 var(--space-3xs) var(--accent-soft); }
    .section-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-md); align-items:center; padding:var(--space-md) var(--space-md); border-bottom:1px solid var(--line); background:var(--surface-2); }
    .section-head h2,.section-title-text { display:block; margin:0; color:var(--ink); font-size:.82rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
    .section-head p,.section-deck { display:block; margin:var(--space-3xs) 0 0; color:var(--muted); font-size:.78rem; line-height:1.45; }
    .section-count { color:var(--faint); font-size:.72rem; border:1px solid var(--line); border-radius:999px; padding:1px var(--space-sm); }
    .section-body { display:grid; gap:var(--space-sm); padding:var(--space-sm); }
    .entry-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-sm); }
    .entry { display:grid; gap:var(--space-sm); min-width:0; padding:var(--space-md) var(--space-md); border:1px solid var(--line); border-radius:var(--r-sm); background:var(--surface-2); }
    .entry.wide { grid-column:1/-1; } .entry h3 { margin:0; font-size:.92rem; } .entry-title { display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--space-sm); }
    .entry-subtitle { color:var(--muted); font-size:.8rem; margin:var(--space-3xs) 0 0; } .content { margin:0; white-space:pre-wrap; font-size:.84rem; line-height:1.55; }
    .kv,.meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1px; background:var(--line-soft); border:1px solid var(--line-soft); border-radius:var(--r-sm); overflow:hidden; }
    .meta { grid-template-columns:repeat(3,minmax(0,1fr)); } .kv div,.meta div { min-width:0; padding:var(--space-xs) var(--space-sm); background:var(--surface); font-size:.8rem; overflow-wrap:anywhere; }
    .label { display:block; color:var(--faint); font:700 .61rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.11em; text-transform:uppercase; margin-bottom:var(--space-3xs); }
    details.sensitive-section summary { display:flex; justify-content:space-between; gap:var(--space-md); align-items:center; padding:var(--space-md) var(--space-md); cursor:pointer; background:color-mix(in srgb,var(--danger),transparent 96%); list-style-position:inside; }
    .sensitive-label { color:var(--danger); font:700 .67rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
    details.sensitive-section[open] summary { border-bottom:1px solid var(--line); }
    /* Resume reading hierarchy; scoped so other workspaces keep their grids. */
    .profile-shell .profile-sections { width:min(100%,1080px); margin:var(--space-xl) auto; gap:var(--space-xl); }
    .profile-shell .profile-section { scroll-margin-top:var(--space-lg); }
    .profile-shell .section-head { padding:var(--space-lg) var(--space-2xl); background:var(--surface); border-bottom-color:var(--line-soft); }
    .profile-shell .section-head h2 { font-size:.76rem; letter-spacing:.1em; }
    .profile-shell .section-body { padding:0; gap:0; }
    .profile-shell .section-body > .empty { margin:var(--space-lg); }
    .profile-shell .entry-grid { gap:0; }
    .profile-shell .entry { padding:var(--space-xl) var(--space-2xl); border:0; border-radius:0; background:transparent; }
    .profile-shell .entry + .entry { border-top:1px solid var(--line-soft); }
    .profile-shell .resume-entry { gap:var(--space-md); }
    .profile-shell .resume-header { display:flex; align-items:baseline; justify-content:space-between; gap:var(--space-md) var(--space-xl); }
    .profile-shell .resume-heading { min-width:0; }
    .profile-shell .resume-heading h3 { font-size:1.06rem; line-height:1.4; letter-spacing:-.015em; overflow-wrap:anywhere; }
    .profile-shell .resume-organization { margin:var(--space-3xs) 0 0; font-size:.91rem; font-weight:550; line-height:1.5; }
    .profile-shell .entry-subtitle { font-size:.83rem; line-height:1.5; overflow-wrap:anywhere; }
    .profile-shell .resume-dates { flex:0 0 auto; max-width:40%; margin:0; color:var(--muted); font-size:.82rem; line-height:1.5; text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .profile-shell .content,.profile-shell .resume-highlights { max-width:88ch; font-size:.88rem; line-height:1.65; overflow-wrap:anywhere; }
    .profile-shell .resume-highlights { margin:0; padding-left:var(--space-lg); }
    .profile-shell .resume-highlights li + li { margin-top:var(--space-xs); }
    .profile-shell .resume-highlights li::marker { color:var(--muted); }
    .profile-shell .profile-badges { display:flex; flex-wrap:wrap; gap:var(--space-sm) var(--space-lg); }
    .profile-shell .profile-badge-group { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-2xs); min-width:0; }
    .profile-shell .profile-badge-label { color:var(--muted); font-size:.69rem; margin-right:var(--space-2xs); }
    .profile-shell .profile-badge { max-width:100%; padding:var(--space-3xs) var(--space-sm); border-radius:999px; font:500 .74rem/1.6 ui-sans-serif,system-ui,sans-serif; text-transform:none; overflow-wrap:anywhere; white-space:normal; }
    .profile-shell .profile-badge-skill { color:var(--accent); border-color:color-mix(in srgb,var(--accent),transparent 72%); background:var(--accent-soft); }
    .profile-shell .profile-badge-stack { color:var(--ink); }
    .profile-shell .resume-facts { display:flex; flex-wrap:wrap; gap:var(--space-sm) var(--space-xl); margin:0; font-size:.8rem; }
    .profile-shell .resume-facts > div { display:flex; flex-wrap:wrap; gap:var(--space-xs); min-width:0; }
    .profile-shell .resume-facts dt { color:var(--muted); }
    .profile-shell .resume-facts dd { margin:0; overflow-wrap:anywhere; }
    .profile-shell .resume-links { display:flex; flex-wrap:wrap; gap:var(--space-xs) var(--space-lg); font-size:.8rem; overflow-wrap:anywhere; }
    .profile-shell .resume-links > span { min-width:0; }
    .profile-shell .profile-evidence { min-width:0; margin:var(--space-2xs) 0 0; }
    .profile-shell .profile-evidence > summary,.profile-shell .work-outline > summary { width:fit-content; max-width:100%; color:var(--muted); font-size:.74rem; cursor:pointer; }
    .profile-shell .profile-evidence > summary:hover,.profile-shell .work-outline > summary:hover { color:var(--ink); }
    .profile-shell .profile-evidence > .kv { margin-top:var(--space-sm); }
    .profile-shell .profile-private { min-width:0; }
    .profile-shell .profile-private > summary { padding:var(--space-md) var(--space-2xl); color:var(--muted); font-size:.8rem; cursor:pointer; }
    .profile-shell .profile-contact .profile-private > summary { padding:var(--space-xs) 0; }
    .profile-shell .profile-contact .profile-private > .kv { margin-top:var(--space-sm); }
    .profile-shell .profile-contact h3 { font-size:1.65rem; letter-spacing:-.035em; }
    .profile-shell .profile-headline { margin:var(--space-2xs) 0 0; font-size:1rem; color:var(--muted); }
    .profile-shell .work-outline { margin:0; }
    .profile-shell .detail-outline { font-size:.83rem; line-height:1.6; overflow-wrap:anywhere; }
    .profile-shell .profile-skill-groups { padding:0 var(--space-2xl); }
    .profile-shell .profile-skill-group { display:grid; grid-template-columns:150px minmax(0,1fr); align-items:start; gap:var(--space-md) var(--space-lg); padding:var(--space-lg) 0; }
    .profile-shell .profile-skill-group + .profile-skill-group { border-top:1px solid var(--line-soft); }
    .profile-shell .profile-skill-group > h3 { margin:var(--space-2xs) 0 0; color:var(--muted); font-size:.82rem; font-weight:600; overflow-wrap:anywhere; }
    .profile-shell .profile-skill-list { display:flex; flex-wrap:wrap; align-items:start; gap:var(--space-sm); min-width:0; }
    .profile-shell .profile-skill { max-width:100%; min-width:0; }
    .profile-shell .profile-skill > summary { display:flex; align-items:center; gap:var(--space-2xs); max-width:100%; cursor:pointer; list-style:none; }
    .profile-shell .profile-skill > summary::-webkit-details-marker { display:none; }
    .profile-shell .profile-skill > summary .profile-badge::after { content:'+'; margin-left:var(--space-xs); opacity:.7; }
    .profile-shell .profile-skill[open] > summary .profile-badge::after { content:'−'; }
    .profile-shell .profile-skill > summary:hover .profile-badge { border-color:var(--accent); }
    .profile-shell .profile-skill[open] { flex-basis:100%; padding:var(--space-md); border:1px solid var(--line); border-radius:var(--r-sm); background:var(--surface-2); }
    .profile-shell .profile-skill-detail { display:grid; gap:var(--space-sm); margin-top:var(--space-sm); }
    @media(max-width:760px){.profile-shell .profile-sections{margin:var(--space-md) auto}.profile-shell .profile-section{scroll-margin-top:72px}.profile-shell .entry{padding:var(--space-lg)}.profile-shell .section-head,.profile-shell .profile-private > summary{padding:var(--space-md) var(--space-lg)}.profile-shell .resume-header{flex-direction:column;align-items:flex-start;gap:var(--space-xs)}.profile-shell .resume-dates{max-width:100%;text-align:left}.profile-shell .profile-skill-groups{padding:0 var(--space-lg)}.profile-shell .profile-skill-group{grid-template-columns:minmax(0,1fr);gap:var(--space-sm)}.profile-shell .profile-contact h3{font-size:1.4rem}}
    @media(max-width:1080px){.filter-grid{grid-template-columns:repeat(3,minmax(150px,1fr))}.filter-search{grid-column:span 2}}
    @media(max-width:760px){main,.shell{width:min(100vw - var(--space-lg),1280px);margin-top:var(--space-lg)}header,.page-hero{display:block}.nav{justify-content:flex-start;margin-top:var(--space-md)}.nav-group{align-items:flex-start}.result-count{text-align:left}.filter-grid{grid-template-columns:1fr}.filter-search{grid-column:auto}.filter-help{width:100%;margin-left:0}.entry-grid,.kv,.meta{grid-template-columns:1fr}.section-index{position:static;max-height:220px;overflow:auto}.card-head{display:block}table,thead,tbody,tr,th,td{display:block}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}tr{padding:var(--space-xs) 0;border-bottom:1px solid var(--line)}td{border:0;padding:var(--space-xs) var(--space-md)}td::before{content:attr(data-label);display:block;color:var(--faint);font:700 .61rem ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;margin-bottom:var(--space-3xs)}.table-scroll{overflow:visible}.app-viewport{height:auto;overflow:visible}.app-main{overflow:visible}.results-region{overflow:visible;min-height:0}main.app-doc{overflow:visible;padding:var(--space-lg) var(--space-md) 48px}.app-header{position:sticky;top:0;z-index:10}.toolbar{flex-wrap:wrap;height:auto}.filter-strip{height:auto;flex-wrap:wrap;padding:var(--space-2xs) 0}.filter-control{max-width:none}.filter-search{flex:1 1 100%;max-width:none}}
    @media(max-width:560px){main,.shell{width:min(100vw - var(--space-md),1280px);margin-top:var(--space-md)}.page-hero h1{font-size:1.3rem}.card{padding:var(--space-md)}.kv,.meta{gap:var(--space-xs)}.badge{font-size:.66rem;padding:var(--space-3xs) var(--space-xs)}.nav a{font-size:.74rem;padding:var(--space-3xs) var(--space-xs)}.nav-leaves a{font-size:.7rem}.profile-tabs a{font-size:.7rem}td{padding:var(--space-3xs) var(--space-sm)}.empty,.empty-panel{padding:var(--space-lg)}.readonly-strip{gap:var(--space-3xs)}.section-index{max-height:150px}}
  `;
}

module.exports = { baseStyles };

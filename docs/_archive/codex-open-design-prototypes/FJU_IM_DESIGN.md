# FJU IM prototype design contract

> PROTOTYPE ONLY. This file aligns three independent throwaway UI sessions. It is not production code or a final brand manual.

## Product voice

- Traditional Chinese first.
- Official, calm, clear, and student-friendly.
- Public pages should feel like an academic editorial site, not a SaaS landing page.
- Logged-in pages should answer “我現在要做什麼？” before showing statistics.
- Use realistic but entirely fictional names, IDs, dates, files, and projects.

## Verified visual anchors

Sampled from the public [FJU Department of Information Management site](https://www.im.fju.edu.tw/) on 2026-08-17:

- Navy: `#003366` — primary brand, navigation, headings.
- Deep navy: `#012243` / `#003062` — dark surfaces and hover states.
- Orange: `#E56E00` — primary action and editorial accent.
- Warm orange surface: `#FFF4EA` / `#FFEBD9` — highlighted notices.
- Ink: `#333333` / `#54595F` — body and secondary text.
- White: `#FFFFFF` — main surface.
- Current site frequently uses Roboto; prototypes use `Inter, "Noto Sans TC", system-ui, sans-serif` for clearer Traditional Chinese UI while preserving its neutral tone.

## Semantic tokens

```css
:root {
  --brand-navy: #003366;
  --brand-navy-deep: #012243;
  --brand-orange: #e56e00;
  --brand-orange-hover: #c85f00;
  --brand-orange-soft: #fff4ea;
  --page: #f6f8fb;
  --surface: #ffffff;
  --surface-muted: #f0f4f8;
  --ink: #1d2939;
  --ink-secondary: #5c6878;
  --line: #dce3eb;
  --success: #157f5b;
  --success-soft: #e8f7f1;
  --warning: #b95c00;
  --warning-soft: #fff4e5;
  --danger: #b42318;
  --danger-soft: #fff0ee;
  --info: #175cd3;
  --info-soft: #eff6ff;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;
  --shadow-card: 0 8px 28px rgba(1, 34, 67, 0.08);
}
```

## Shared component language

- Buttons: navy primary for navigation/confirm; orange for the single emphasized public CTA; destructive actions are red and never visually dominant.
- Cards: white, 1px cool-gray border, restrained shadow, 12–18px radius. Avoid walls of identical cards.
- Status: always combine color + icon/label; never color alone.
- Tables: sticky header, stable row height, ellipsis for long cells, horizontal scroll hint, clear filter/search tools.
- Forms: persistent label and help/error text. Show autosave state in plain language.
- Images: public editorial cards use 16:9; allow `contain` or focal positioning for people/posters.
- Motion: 160–220ms ease-out for navigation, drawers, filters, and hover; no decorative parallax.

## Responsive behavior

- Judge at 1440px desktop and 390px mobile.
- Public page: one column on mobile; two or three columns only when content remains readable.
- Dashboard: sidebar collapses into a sheet/bottom navigation; deadline and next action stay above the fold.
- Editor: desktop may use three columns. Mobile becomes a step flow or canvas + bottom sheet; do not squeeze three columns side by side.

## Forbidden defaults

- No revenue, MRR, subscriptions, churn, conversion funnels, billing, or fake SaaS analytics.
- No generic gradient-heavy startup hero.
- No kanban/chat/billing donor screens unrelated to project administration.
- No real student data, credentials, VM secrets, private files, or copied Google Sheet rows.
- Do not present static mock controls as working without a visible “prototype” note.

## Prototype mechanics

- Each session produces one self-contained `index.html` with three structurally different variants.
- Variants switch with `?variant=A`, `?variant=B`, `?variant=C`, bottom arrows, and keyboard Left/Right.
- The switcher is visibly marked “原型切換器” and is not part of the candidate UI.
- Interactions use in-memory fake state only. Reloading may reset state.
- Each route exposes a small “狀態檢視” panel or visible feedback after an interaction.

## Session questions

1. Public site: editorial brand vs news/deadline-first vs project showcase — which hierarchy makes the old hidden site genuinely useful?
2. Student dashboard: timeline-first vs task-state-first vs Kiranism-style shell — which makes the next action obvious within five seconds?
3. Admin editor: three-column builder vs full-width canvas vs list-and-drawer — which makes “one backend, separate public destinations” understandable without training?

## Product references

- Canonical spec: `/Users/lubaiyu/Documents/roy422的人生online/🗺️ 輔大資管系專題網站重構 MOC.md`
- Current department site: https://www.im.fju.edu.tw/
- Old project site: https://project.im.fju.edu.tw/Home
- shadcn/ui: https://ui.shadcn.com/docs/components
- Dashboard UX donor: https://github.com/Kiranism/next-shadcn-dashboard-starter
- Form-builder interaction donor: https://github.com/hasanharman/form-builder
- Open Design research: `../docs/research/open-design-prototype-fit.md`

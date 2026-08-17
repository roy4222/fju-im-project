Create a throwaway, self-contained HTML prototype for the administrator’s unified “專題事務編輯器” in the FJU IM project-management website. It must test whether one backend editing workflow can publish to clearly separate frontend destinations without confusing administrators. Use fake data and in-memory state only.

Use Traditional Chinese and the shared brand: navy #003366, deep navy #012243, orange #E56E00, warm orange #FFF4EA, white/cool-gray surfaces, Inter/Noto Sans TC/system fonts. Borrow the interaction ideas of hasanharman/form-builder and the polish/navigation feel of Kiranism, but do not embed either product or include billing/revenue/SaaS content.

Produce one index.html with inline CSS and JavaScript, no CDN/runtime dependency. Put three structurally different variants in the same artifact, selected by ?variant=A, B, or C and a fixed bottom prototype switcher with buttons and Left/Right keyboard shortcuts:

- A: left component palette, center canvas, right selected-block settings.
- B: publishing destination at the top with a wide full-canvas editing flow.
- C: affair item list with a right-side quick-edit drawer.

Use one clear data model to simulate four jobs: announcement; downloadable resource with attachment; whole-group document submission; project-requirements form. Each record has exactly one primary frontend destination. Homepage/Dashboard exposure is an automatic summary, not another copied destination. Allow audience, deadline, status, content blocks, requested fields, upload requirement, and preview persona.

At least three interactions must actually work in memory: add a field/block, reorder it, change destination or audience, switch visitor/student preview, and publish with an explicit receipt. Show autosave state and a readable JSON/state inspector. Mark drag controls honestly; if native drag is unreliable, provide accessible move-up/down buttons. At 390px mobile use a step flow or canvas plus sheet, never squeeze three desktop columns together. Test at 1440px too. Add visible focus, keyboard-accessible controls, and reduced-motion support. Mark PROTOTYPE.

At the top of the source, record the design question: which editor structure makes “後台統一、前台分開” understandable without training?

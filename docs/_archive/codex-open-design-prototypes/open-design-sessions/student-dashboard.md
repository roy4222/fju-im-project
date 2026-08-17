Create a throwaway, self-contained HTML prototype for the logged-in student Dashboard of the FJU IM project-management website. This is a UI direction study with fake data only, not production code.

Use Traditional Chinese and the shared brand: navy #003366, deep navy #012243, orange #E56E00, warm orange #FFF4EA, white/cool-gray surfaces, Inter/Noto Sans TC/system fonts. The logged-in UX may borrow the smooth shell/search/navigation feel of Kiranism next-shadcn-dashboard-starter, but remove billing, revenue, subscription, kanban, and chat-demo content. The first screen must answer “我現在要做什麼？” before showing statistics.

Produce one index.html with inline CSS and JavaScript, no CDN/runtime dependency. Put three structurally different variants in the same artifact, selected by ?variant=A, B, or C and a fixed bottom prototype switcher with buttons and Left/Right keyboard shortcuts:

- A: timeline and next-deadline first.
- B: work queue grouped by draft / submitted / resubmit / overdue state.
- C: Kiranism-like responsive sidebar, shortcuts, and focused work list.

Use the same fictional data across variants: next deadline and countdown; current five-person group confirmation progress; group type and adviser; draft, submitted, resubmit, and overdue affairs; recent announcements and rules; personal consent and whole-group signature progress; shared draft and submission-version history. Never show scores, comments, rankings, or score placeholders to students.

Include at least three real in-memory interactions: filter tasks, expand version history, and simulate one safe prototype action with visible success/state feedback. Provide light/dark theme toggle. On 390px mobile, collapse navigation without hiding the next deadline/action; test 1440px desktop too. Add accessible labels, visible focus, and reduced-motion support. Mark PROTOTYPE and expose a compact visible state inspector.

At the top of the source, record the design question: which layout makes the student's next action obvious within five seconds?

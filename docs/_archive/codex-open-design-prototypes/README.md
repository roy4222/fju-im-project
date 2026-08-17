# FJU IM throwaway UI prototypes

These artifacts answer UI direction questions before production implementation. They contain no production authentication, database, file storage, or real personal data.

Each folder owns one independent prototype session:

- [`public-site/`](./public-site/) — public department project site.
- [`student-dashboard/`](./student-dashboard/) — logged-in student home.
- [`admin-editor/`](./admin-editor/) — unified project-affairs editor.

Open each folder's `index.html` directly, or follow its local README. Use `?variant=A`, `B`, or `C` to compare structurally different candidates.

All three sessions share [FJU_IM_DESIGN.md](./FJU_IM_DESIGN.md).

## Validation

Independent headless-Chrome validation covers all nine desktop variants plus one 390 px keyboard-switch check per prototype. It checks runtime and console errors, external requests, prototype labelling, URL variant state, horizontal overflow, and screenshots.

- Report: [`screenshots/validation-report.json`](./screenshots/validation-report.json)
- Rendering/responsive result: **12/12 checks passed**
- Core interactions: **3/3 flows passed** (public filters/login preview, student filter/theme/version, admin add/destination/visitor gate/publish receipt)
- Network: **no external requests**
- Open Design: all three accepted HTML artifacts were imported into three local projects and returned HTTP 200 from their preview routes.
- Open Design preview runtime: **3/3 passed** with scripts and representative interactions running inside the preview route.

These remain throwaway design artifacts. A selected direction must be rebuilt with the production Next.js and shadcn/ui component contracts.

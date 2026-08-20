# UI Craft Research — rounding & spacing (2026-08-20)

Trigger: Mino 20:13 — "배경색이나 브랜딩보다는 라운딩이나 마진에서 사람/AI
작업물이 차이가 많이 나거든. 디자인 원칙이나 논문같은거 리서치해서 개선해줘."
Researched via magi-researcher (web pass); applied as the v2 craft pass in
app.css's 0.2.6 override block. Companion to docs/design-research-2026-08.md
(which already carried the concentric rule from Apple §1-3 — this doc adds
numbers, floors, and citations).

## Rules applied

1. **Concentric radius** (Apple ConcentricRectangle, WWDC25; web "radius
   nesting rule", Frontend Masters/CSS-Tricks): inner = outer − padding.
   Floor: never let inner hit ≤2–4px unless outer is square; tune by eye
   (GitLab DS issue #3023). → our tier: --radius-l 20 = --radius-m 12 +
   --s2 8, so an l-container with 8px padding gives its children exactly m.
2. **Radius vocabulary 3–4 rect values + pill** (Material 3 shape scale;
   Vercel Geist 4/6/12/16; Linear ~4/6/8/12/16; Apple ~8-24 reverse-eng'd,
   unpublished officially). Pill 9999 reserved for capsules. → ours:
   6 / 12 / 20 / pill. No ad-hoc radii (18/13 purged).
3. **8pt grid, 4pt half-steps** (Material spec; term popularized by Bryn
   Jackson, Spec.fm 2015; Apple implicit): scale 4 8 12 16 20 24 32.
   Root font is 13.5px → rem spacing lands off-grid, so spacing in the
   override block is px-token only; rem stays for type.
4. **Gestalt proximity** (NN/g): inter-group gap visibly larger than
   intra-group, practitioner heuristic ≥2–3×. No academically sourced
   multiplier exists — the circulating "40px/120px study" numbers are
   untraceable, don't cite them. → bubbles: same-sender 8px, sender-change
   16px, meta row opens a turn at 16px.
5. **Refactoring UI** (Wathan/Schoger): spacing scale is a closed menu
   (adjacent values ≥25% apart); hierarchy via weight/opacity before size;
   start too-spacious then trim. → two small type sizes only: 0.8rem
   caption / 0.72rem micro (was seven: 0.72–0.88).
6. **Line length 50–75ch, 66 sweet spot; line-height 1.45–1.55 chat body**
   (pimpmytype, uiuxatlas). → bubbles max-width min(78%, 62ch); body 1.55.
7. **Optical alignment** (RingCentral UX, Rails Designer): geometric ≠
   visual center; asymmetric glyphs nudge 1–2px; icon boxes match
   line-height not intrinsic size. → attach '+' line-height 30px in 32px box.
8. **Accent is semantic, ambient glow is AI-slop** (our own
   design-research-2026-08 §0 avoid-list + §recipe 8). → body's two
   accent radial glows replaced with one neutral top light (white 0.045).
9. **Mono = technical register** (design-research-2026-08 §recipe 9,
   Vercel). → timestamps + sysline in ui-monospace.

## Research backing (why craft pays at all)
- Aesthetic-usability effect: Kurosu & Kashimura CHI'95 (26 ATM UIs, n=252)
  — perceived usability tracks aesthetics more than actual usability.
- Curvature preference: Bar & Neta, Psych Science 2006 — curved contours
  preferred over sharp (threat-cue hypothesis; amygdala fMRI follow-up).

Full source list in the session transcript (research agent af8700c5,
2026-08-20 20:1x). Key links: frontendmasters.com/blog/the-classic-border-
radius-advice-plus-an-unusual-trick, developer.apple.com/documentation/
swiftui/concentricrectangle, m3.material.io/styles/shape/corner-radius-scale,
nngroup.com/articles/gestalt-proximity, nngroup.com/articles/aesthetic-
usability-effect.

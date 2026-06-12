# README Shotlist

Capture these in one session, then drop them into the README image slots (each is marked with a
`<!-- TODO(...) -->` comment matching the **slot id** below).

## How to publish images on GitHub

GitHub doesn't need the files committed. The easiest path:

1. Open a draft issue (or any PR comment box) in the repo.
2. Drag-and-drop each image/GIF into it — GitHub uploads it and gives you a
   `https://github.com/user-attachments/assets/...` URL.
3. Paste that URL into the matching `<img src="...">` in `README.md`.
4. Discard the draft issue.

## General capture notes

- **Theme:** pick one (the Quiet Editorial look) and stay consistent across every shot.
- **Resolution:** capture at 2x / retina. Stills ~1600px wide, hero GIF 1280–1600px wide.
- **Anonymize:** use a clean profile or scrub anything sensitive (tokens, names, private windows). Remember these go on the front page of the repo.
- **Real data beats lorem:** relatable, real-looking content sells far better than empty states.
- **Format:** PNG or WebP for stills; GIF (or MP4→GIF) for the hero.

---

## 1. Hero GIF — `TODO(hero-gif)`  ⭐ highest priority

The single most important asset. This is what converts a scroller into a star.

- **View:** Search
- **Storyboard (~8s loop):**
  1. Start on an empty/cleared search bar.
  2. Type a real, relatable query, e.g. `that error about websocket` or `the pricing page I saw last week`.
  3. Results animate in with snippet highlights.
  4. Hover/click one result to show the screenshot detail.
- **Length:** 6–10s, looping, no audio.
- **Tip:** record at a calm typing speed; trim dead frames; keep it under ~5MB if possible.

## 2. Still — Search — `TODO(still-search)`

- **View:** Search, results grid
- **Must show:** scene-dedup badges + the Semantic badge on at least one result.
- A populated, varied result set (different apps/sites) reads best.

## 3. Still — Ask — `TODO(still-ask)`

- **View:** Ask (AI chat) — your standout differentiator.
- **Must show:** an AI answer with **inline citations** and the **Sources card** visible.
- Bonus: a pinned screenshot context chip and the model picker.

## 4. Still — Dashboard — `TODO(still-dashboard)`

- **View:** Dashboard — the most visually impressive screen.
- **Must show:** the heatmap calendar + at least one activity chart and the top-apps breakdown.
- Pick a day/week with real-looking activity so charts aren't sparse.

## 5. Still — Rewind — `TODO(still-rewind)`

- **View:** Rewind timelapse player — unique, no competitor has it.
- **Must show:** the scrubber and speed controls, mid-playback frame visible.

---

## Slot → README mapping

| Slot id | README location | Current state |
|---|---|---|
| `hero-gif` | top hero, below badges | placeholder still (reusing existing search shot) |
| `still-search` | left of hero pair | reusing existing shot |
| `still-ask` | right of hero pair | reusing existing shot |
| `still-dashboard` | Features section pair (left) | placeholder.com image |
| `still-rewind` | Features section pair (right) | placeholder.com image |

Once all five are captured and pasted in, delete this line and the `TODO(...)` comments in `README.md`.

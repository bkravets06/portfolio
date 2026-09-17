# Notes for AI agents and other contributors

This is Benjamin Kravets' personal site, **bjkravets.com**: a plain static site
with no build step, published by GitHub Pages from the root of the `main`
branch (custom domain via `CNAME`; Jekyll is disabled by `.nojekyll`).

## Layout

- `index.html` only redirects to `home/`, which is the real home page.
- `projects/` — one page per project; `assets/` — images, PDFs, 3D models;
  `css/style.css` and `js/main.js` are shared by those pages.
- `file/` — a **hidden** in-browser file converter at `bjkravets.com/file`
  (images, audio, video, 3D meshes, STEP/IGES/BREP). It has its own
  [README](file/README.md) with architecture, status and an open TODO list —
  read it before changing anything under `file/`.

## Rules for the hidden page

- It exists only for people who have the URL. Never link to `/file` from the
  rest of the site, never add it to `sitemap.xml`, and do not add it to
  `robots.txt` either (that file is public and would advertise the path). The
  page carries `<meta name="robots" content="noindex, nofollow">`.
- Its visual style deliberately copies the Pebble watch aesthetic used in the
  Ride Glance phone app (`PebbleStyle.swift` in the `PebbleRideGlance` repo):
  Pebble's 00/55/AA/FF palette, a `#005500` status bar, grey section strips,
  uppercase tracked labels, flat block buttons. Keep new UI in that language.

## Working locally

- Serve the repo root, e.g. `python3 -m http.server 8765 --bind 127.0.0.1`,
  then open `http://127.0.0.1:8765/home/` or `/file/`. Python's server sends
  no cache headers, so hard-reload (or add `?v=<n>`) after editing.
- No package manager, bundler or `node_modules` in the repo. Third-party code
  is loaded from jsDelivr with pinned versions, or vendored (small files only)
  under `file/lib/`.
- Deploying is just pushing to `main`; Pages rebuilds in about a minute.
- Commit messages: short imperative subject line, like the existing history.

## What still needs doing

See the **Status** and **TODO** sections of [file/README.md](file/README.md).

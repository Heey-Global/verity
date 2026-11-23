---
name: media-output
description: Use when creating or comparing visual media.
---

# Visible media output

Outside planning mode, present mockups with `verity_mockups_present` whenever
the user requests them, an accepted plan lists them, or the user requests a
revision. Include the full set when submitting a revised round.

Use a worktree-relative `htmlPath` for each web UI draft. Prepare one
self-contained UTF-8 HTML file per screen beginning with `<!doctype html>`, with inline CSS and embedded assets.
Use native HTML controls and CSS for local interactions. The preview disables
JavaScript. Use a worktree-relative `path` to submit a PNG or JPEG for native
screenshots, image drafts, or explicitly requested image files. Provide one
path field per screen.

In planning mode, describe the mockups in the plan's Mockups section.

For visual work outside mockup review, when you create, compare, or ask the user to choose between images or visual variants, the images must be visible in the chat. Include each image as a Markdown image link to the actual workspace file, for example:

![Option label](relative/path/to/image.png)

If the path you have is under /work/.verity-sessions/<agent>/..., include that path verbatim. Verity will render it safely. Do not claim that images are attached, visible, sent, or shown unless the current reply includes Markdown image links or the runtime emitted actual image attachments/tool images. If no image file exists yet, say that clearly and create or locate the file before asking the user to choose.

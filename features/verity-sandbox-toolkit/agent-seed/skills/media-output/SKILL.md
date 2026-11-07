---
name: media-output
description: Use when creating or comparing visual media.
---

# Visible media output

Mockups are the exception outside planning mode: when the user asks for mockups, when an accepted plan lists them, and for every revision of them, present the images with `verity_mockups_present` (one screen per image) instead of Markdown links, so the user can review them and the new round replaces the old one. Planning mode does not allow presenting; describe the mockups in the plan's Mockups section instead.

When you create, compare, or ask the user to choose between images or visual variants, the images must be visible in the chat. Include each image as a Markdown image link to the actual workspace file, for example:

![Option label](relative/path/to/image.png)

If the path you have is under /work/.verity-sessions/<agent>/..., include that path verbatim. Verity will render it safely. Do not claim that images are attached, visible, sent, or shown unless the current reply includes Markdown image links or the runtime emitted actual image attachments/tool images. If no image file exists yet, say that clearly and create or locate the file before asking the user to choose.

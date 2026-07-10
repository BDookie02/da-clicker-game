# Final character art pipeline

The game is art-drop-in ready: any PNG placed at `public/sprites/<slot>.png`
automatically replaces that character's procedural sprite at runtime (nearest-
filtered, anger shown as a red tint + the car shake). No code changes needed.

## One-time unlock (you, ~30 seconds)
The Higgsfield MCP is installed project-scoped (`.mcp.json`) but its server
uses OAuth, which only an interactive session can approve:

1. Open a terminal in this folder, run `claude`, then `/mcp`.
2. Select `higgsfield` → Authenticate → approve in the browser.

That's it. Then tell Claude "run the art pass" — it reads
`docs/sprite-manifest.json`, generates every slot, and saves PNGs into
`public/sprites/`.

## Spec for every generated image
- Transparent background, square (512×512+), head-and-shoulders bust,
  facing the viewer, eyes locked dead-center on camera.
- Style: chunky 90s low-res pixel-art / PS1 memory-card portrait. Hard black
  outline. Limited palette. Reads at 48px.
- These are OUR original characters (see manifest descriptions). Do not
  generate lookalikes of existing copyrighted game/anime characters.
- Slots `char_gen_0..39` are the endless procedural pool: any varied original
  "driver" busts matching the style guide (mix ages, skin tones, hats,
  facial hair, accessories).

## Slot → file mapping
`docs/sprite-manifest.json` holds one generation prompt per slot. File name
must equal the slot key: e.g. `public/sprites/char_og.png`.

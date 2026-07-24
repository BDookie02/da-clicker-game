# Blockbench cosmetic assembly line

This is an isolated art-production pipeline. It does not change `src/` or the
Android project. It reads the existing 30-item `public/assets/cosmetics-assembly.json`
manifest and writes native Blockbench projects under `tools/blockbench/output/`.

## Run it

```powershell
npm.cmd run assemble:blockbench:all              # one-shot, resumable queue
powershell -ExecutionPolicy Bypass -File scripts/run-blockbench-assembly.ps1 -OpenFirst
npm run assemble:blockbench                 # generate the next 5 items
npm run assemble:blockbench -- --all       # finish every remaining item
npm run assemble:blockbench -- --reset     # clear checkpoints and restart
npm run assemble:blockbench -- --open-first # open the first new model in Blockbench
```

Each item writes a `.bbmodel` and an embedded texture, validates the geometry,
and then updates `tools/blockbench/.assembly-state.json`. The one-shot wrapper
also exports a matching `.glb` for every model under
`tools/blockbench/output/glb/`. If the machine sleeps, the app closes, or a
batch fails, rerunning the command resumes at the next item. Nothing is copied
into `public/` until visual review and a separate integration step are
approved.

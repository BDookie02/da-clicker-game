import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const scene = fs.readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('defeat transition overrides manual free-look with the road view', () => {
  const drive = scene.indexOf('driveToNext(nextDef');
  const reset = scene.indexOf('this.resetTapLook();', drive);
  const road = scene.indexOf("this.gaze = 'road'", drive);

  assert.ok(drive >= 0 && reset > drive && road > reset);
});

test('arrival restores exact opponent eye contact before gameplay resumes', () => {
  assert.match(
    scene,
    /focusOpponentNow\(\) \{[\s\S]*?this\.freeLook = false;[\s\S]*?this\.gaze = 'opponent';[\s\S]*?this\.camera\.lookAt/,
  );

  const driveCallback = main.indexOf('scene.driveToNext');
  const setOpponent = main.indexOf('scene.setOpponent(game.opponent)', driveCallback);
  const focusOpponent = main.indexOf('scene.focusOpponentNow()', driveCallback);
  const resumeInput = main.indexOf('transitioning = false', driveCallback);

  assert.ok(
    driveCallback >= 0
      && setOpponent > driveCallback
      && focusOpponent > setOpponent
      && resumeInput > focusOpponent,
  );
});

test('the green eye-control arrow appears only during playable broken eye contact', () => {
  assert.match(main, /eyeContactArrow\.className = 'garage-arrow eye-contact-arrow'/);
  assert.match(main, /eyeContactArrow\.textContent = '▲'/);
  assert.match(
    main,
    /const shouldShow = gameplayEngaged\s*&& !scene\.inGarage\s*&& !transitioning\s*&& !ui\.isPanelOpen\s*&& !tutorial\.isActive\s*&& !scene\.isMakingEyeContact\(\)/,
  );
  assert.match(main, /eyeContactArrow\.style\.left = `\$\{rect\.left \+ rect\.width \/ 2\}px`/);
  assert.match(main, /eyeContactArrow\.style\.top = `\$\{rect\.bottom \+ 4\}px`/);
});

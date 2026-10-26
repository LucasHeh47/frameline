// Keyboard shortcut reference and About dialog.
import type { App } from './app';
import { h, kbd } from './dom';
import { platform } from './platform';
import { dialog } from './widgets';

const MOUSE: [string, string][] = [
  ['Move clips (copies with Alt; inserts with Ctrl)', 'Drag'],
  ['Trim a clip', 'Drag its edge'],
  ['Ripple trim (later clips follow)', 'Ctrl+drag an edge'],
  ['Pick just the picture or just the sound of a clip', 'Alt+click'],
  ['Scroll the timeline sideways', 'Shift+wheel'],
  ['Zoom the timeline', 'Ctrl+wheel or Alt+wheel'],
  ['Add a keyframe on a volume / opacity line', 'Ctrl+click the line'],
  ['Move, size or turn the selected clip', 'Drag it in the Program monitor'],
  ['Edit a title’s words', 'Double-click it in the Program monitor'],
  ['Change a number in Effect Controls', 'Drag it sideways (Shift: faster)'],
];

export function showShortcuts(app: App): void {
  const table = h('div', { class: 'shortcut-table' });
  table.append(h('div', { class: 'cat' }, 'Mouse'));
  for (const [label, keys] of MOUSE) table.append(h('div', null, label), h('div', null, kbd(keys)));
  const byCat = new Map<string, { title: string; keys: string[] }[]>();
  for (const c of app.commands.all()) {
    if (!c.keys?.length) continue;
    const cat = c.category;
    const list = byCat.get(cat) ?? [];
    list.push({ title: c.title.replace(/…$/, ''), keys: c.keys });
    byCat.set(cat, list);
  }
  for (const [cat, list] of byCat) {
    table.append(h('div', { class: 'cat' }, cat));
    for (const c of list) table.append(h('div', null, c.title), h('div', null, ...c.keys.map((k) => kbd(k))));
  }
  const body = h('div', null, h('p', null, 'Every command is also searchable with Ctrl+Shift+P — no need to memorize these.'), table);
  void dialog('Keyboard shortcuts', body, [{ label: 'Close', value: true, primary: true }], { wide: true });
}

export async function showAbout(_app: App): Promise<void> {
  const version = await platform.appVersion();
  const body = h(
    'div',
    null,
    h('p', null, `Version ${version}${version.includes('-') ? ' (development build)' : ''}. A video editor for YouTube videos, shorts, family films and everything between.`),
    h('p', null, 'A multi-track timeline with ripple, roll, slip, slide and rate-stretch editing; titles and captions; transitions; color correction with Lumetri and LUTs; keying, masks, blur and more effects; keyframes; an audio mixer with effects; and exports to MP4, WebM and MOV made with your computer’s video encoder.'),
    h('p', { class: 'hint' }, 'Part of the same family as Gridline, Pixelline and Baseline.'),
  );
  await dialog('About Frameline', body, [{ label: 'Close', value: true, primary: true }]);
}

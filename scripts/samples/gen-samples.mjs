#!/usr/bin/env node
// Generates the two small sample books in samples/ that exercise Phase 4 on a
// real phone: tables-sample.epub (every table shape the adapter handles, plus
// long unbreakable strings) and devanagari-sample.epub (Marathi, Hindi,
// Sanskrit and symbols). Deterministic: the same script gives the same bytes.
//
//   node scripts/samples/gen-samples.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(repo, 'samples');
const FIXED = new Date(Date.UTC(2020, 0, 1));

const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cells = (tag, values) => values.map((v) => `<${tag}>${esc(String(v))}</${tag}>`).join('');
const rows = (data) => data.map((r) => `<tr>${cells('td', r)}</tr>`).join('\n');

async function epub({ id, title, language, chapters }) {
  const zip = new JSZip();
  const add = (path, data, compression = 'DEFLATE') => zip.file(path, data, { compression, date: FIXED, createFolders: false });

  add('mimetype', 'application/epub+zip', 'STORE');
  add(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  add('OEBPS/style.css', 'body { margin: 0; } p { margin: 0 0 1em; }');

  const manifest = ['<item id="css" href="style.css" media-type="text/css"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  const spine = [];
  const toc = [];
  chapters.forEach((chapter, i) => {
    manifest.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    toc.push(`<li><a href="c${i}.xhtml">${esc(chapter.title)}</a></li>`);
    add(
      `OEBPS/c${i}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="${chapter.lang ?? language}"><head><title>${esc(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h2>${esc(chapter.title)}</h2>\n${chapter.body}\n</body></html>`,
    );
  });
  add('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${toc.join('')}</ol></nav></body></html>`);
  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:vach-sample:${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>${language}</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
  );
  return zip.generateAsync({ type: 'uint8array', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

// ---------------------------------------------------------------------------
// tables-sample.epub
// ---------------------------------------------------------------------------

const LONG_URL = 'https://example.com/a/very/long/path/that/never/breaks/' + 'segment-of-an-unbroken-url-'.repeat(8) + 'end?query=' + 'x'.repeat(40);
const LONG_CODE_LINE = 'const result = computeTheThingThatTakesAVeryLongNameAndManyArguments(firstArgument, secondArgument, thirdArgument, fourthArgument, fifthArgument, sixthArgument);';
const LONG_IDENTIFIER = 'SomeVeryLongClassNameThatKeepsGoingAndGoingWithoutAnySpacesAtAllUntilItIsFarWiderThanAPhoneScreenCanHold';

const statHeader = ['Name', 'Class', 'Lv', 'HP', 'MP', 'STR', 'AGI', 'INT', 'LUK', 'Title'];
const statRows = [
  ['Kaito', 'Swordsman', 42, 1850, 320, 78, 64, 31, 12, 'Dawn Blade'],
  ['Mira', 'Archmage', 44, 910, 2400, 22, 41, 96, 25, 'Storm Caller'],
  ['Doran', 'Paladin', 40, 2600, 540, 71, 28, 40, 18, 'Shield of Ash'],
  ['Wren', 'Rogue', 38, 1120, 410, 49, 88, 37, 61, 'Silent Knife'],
];

const tablesChapters = [
  {
    title: 'Narrow and wide tables',
    body: `<p>This sample has every table shape Vach adapts. Nothing on this page should ever scroll sideways. Rotate the phone and change the font size: the tables re-fit and you stay on the same paragraph.</p>
<p><b>A narrow 2-column table with a header</b> (fits as it is):</p>
<table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody>${rows([['Healing potion', '50 gold'], ['Iron sword', '120 gold'], ['Traveller’s cloak', '75 gold']])}</tbody></table>
<p><b>A 5-column table with a header</b> (becomes compact on a narrow screen):</p>
<table><thead><tr><th>Skill</th><th>Rank</th><th>Cost</th><th>Cooldown</th><th>Effect</th></tr></thead><tbody>${rows([
      ['Fireball', 'C', '30 MP', '5 s', 'Burns a target'],
      ['Ice lance', 'B', '45 MP', '8 s', 'Slows a target'],
      ['Mana shield', 'A', '120 MP', '60 s', 'Absorbs 500 damage'],
    ])}</tbody></table>
<p><b>A 9-column table with a header</b> (too wide even when compact: each row becomes a card, with an Expand Grid button):</p>
<table><thead><tr>${cells('th', ['Strength', 'Agility', 'Endurance', 'Intellect', 'Wisdom', 'Charisma', 'Luck', 'Perception', 'Willpower'])}</tr></thead><tbody>${rows([
      [12, 14, 11, 9, 10, 13, 7, 15, 8],
      [18, 9, 17, 6, 8, 7, 10, 9, 12],
      [8, 16, 9, 18, 17, 12, 11, 14, 15],
    ])}</tbody></table>
<p>The paragraph after the tables, to check that reading continues normally below them.</p>`,
  },
  {
    title: 'Headerless and complex tables',
    body: `<p><b>A headerless 7-column table</b> (no header means no cards: when it is too wide it becomes a placeholder you can open with Expand Grid):</p>
<table><tbody>${rows([
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      ['rest', 'train', 'train', 'rest', 'train', 'hunt', 'rest'],
      ['08:00', '07:30', '07:30', '08:00', '07:00', '05:00', '09:00'],
    ])}</tbody></table>
<p><b>A table with colspan and rowspan</b> (complex: never turned into cards):</p>
<table><thead><tr><th>Party</th><th colspan="2">Combat</th><th colspan="2">Support</th><th colspan="2">Gathering</th></tr><tr><th>Member</th><th>Melee</th><th>Ranged</th><th>Heal</th><th>Buff</th><th>Mining</th><th>Herbs</th></tr></thead><tbody>
<tr><td rowspan="2">Front line</td><td>A</td><td>C</td><td>E</td><td>D</td><td>B</td><td>E</td></tr>
<tr><td>S</td><td>D</td><td>E</td><td>C</td><td>A</td><td>E</td></tr>
<tr><td>Back line</td><td>E</td><td>S</td><td>A</td><td>A</td><td>D</td><td>B</td></tr></tbody></table>
<p><b>A nested table</b> (also complex):</p>
<table><tbody><tr><td>Inventory</td><td>Equipped</td><td>Storage</td><td>Bank</td></tr><tr><td>Potions: 12</td><td><table><tbody><tr><td>Head</td><td>Iron helm</td></tr><tr><td>Hands</td><td>Leather gloves</td></tr></tbody></table></td><td>Crates: 3</td><td>2,400 gold</td></tr></tbody></table>
<p><b>A table with row headers</b> (&lt;th&gt; cells inside the body: complex):</p>
<table><thead><tr><th>Stat</th><th>Base</th><th>Bonus</th><th>Gear</th><th>Buffs</th><th>Total</th><th>Cap</th><th>Rank</th></tr></thead><tbody>
<tr><th>Strength</th>${cells('td', [40, 8, 12, 5, 65, 99, 'B'])}</tr>
<tr><th>Agility</th>${cells('td', [35, 6, 10, 9, 60, 99, 'B'])}</tr>
<tr><th>Intellect</th>${cells('td', [20, 4, 3, 0, 27, 99, 'D'])}</tr></tbody></table>`,
  },
  {
    title: 'Stat sheets',
    body: `<p>A LitRPG-style stat sheet. The header is a first row of &lt;th&gt; cells with no &lt;thead&gt;; ten columns will not fit a phone, so each character becomes a card (and Expand Grid shows the whole sheet).</p>
<table><tbody><tr>${cells('th', statHeader)}</tr>
${rows(statRows)}</tbody></table>
<p>A status window, as a 2-column table without a header:</p>
<table><tbody>${rows([['Name', 'Kaito'], ['Level', 42], ['Class', 'Swordsman'], ['Title', 'Dawn Blade'], ['Guild', 'The Ember Compact'], ['Active quest', 'Deliver the sealed letter to the lighthouse keeper before the tide turns']])}</tbody></table>
<p>The text after the sheets.</p>`,
  },
  {
    title: 'Publisher-styled table',
    body: `<p>This table is exactly as a publisher might have written it: a fixed 900-pixel width, white cells with black text, no-wrap cells, fixed font sizes and column widths. Vach strips all of that and fits it to the screen in your theme (try the night theme: there must be no glaring white cells).</p>
<table width="900" border="1" cellpadding="6" bgcolor="#ffffff" style="width:900px;background-color:#ffffff;color:#000000;font-size:11px"><colgroup><col width="300"/><col width="300"/><col width="300"/></colgroup>
<thead><tr><th width="300" bgcolor="#eeeeee" nowrap="nowrap">Region</th><th width="300" bgcolor="#eeeeee" nowrap="nowrap">Capital</th><th width="300" bgcolor="#eeeeee" nowrap="nowrap">Population</th></tr></thead>
<tbody><tr><td width="300" bgcolor="#ffffff" nowrap="nowrap" style="white-space:nowrap;background-color:#ffffff;color:#000000">Northern Reach</td><td width="300" bgcolor="#ffffff" nowrap="nowrap" style="white-space:nowrap">Frostmere</td><td width="300" bgcolor="#ffffff" nowrap="nowrap" style="white-space:nowrap;text-align:right">1,204,000</td></tr>
<tr><td width="300" bgcolor="#ffffff" nowrap="nowrap" style="white-space:nowrap;background-color:#ffffff;color:#000000">Southern Marches</td><td width="300" bgcolor="#ffffff" nowrap="nowrap" style="white-space:nowrap">Hollowford</td><td width="300" bgcolor="#ffffff" nowrap="nowrap" style="white-space:nowrap;text-align:right">860,500</td></tr></tbody></table>
<p>The paragraph after it.</p>`,
  },
  {
    title: 'Long strings and code',
    body: `<p>A long unbroken URL inside a paragraph: ${esc(LONG_URL)}</p>
<p>A long identifier: <code>${esc(LONG_IDENTIFIER)}</code></p>
<p>A long line of code (it wraps; it does not scroll sideways):</p>
<pre><code>${esc(LONG_CODE_LINE)}
short line
    indented line that is also quite a bit longer than the short one above it, to show that spaces are kept</code></pre>
<p>A table whose cell holds a long URL:</p>
<table><thead><tr><th>Name</th><th>Link</th></tr></thead><tbody><tr><td>Wiki</td><td>${esc(LONG_URL)}</td></tr></tbody></table>
<p>The end of the sample.</p>`,
  },
];

// ---------------------------------------------------------------------------
// devanagari-sample.epub
// ---------------------------------------------------------------------------

const devanagariChapters = [
  {
    title: 'वाच',
    lang: 'mr',
    body: `<p>वाच — वाचन, वाचा आणि वाणी. हे नमुना पुस्तक देवनागरी लिपीतील मराठी, हिन्दी आणि संस्कृत मजकूर दाखवते. प्रत्येक अक्षर स्पष्ट दिसले पाहिजे; चौकोन किंवा रिकामे ठिपके दिसू नयेत.</p>
<p>Vach is the Marathi/Hindi/Sanskrit word for speech and reading: <b>वाच</b> (vāc). If the Devanagari below shows boxes (□) on your phone, tell me which line.</p>`,
  },
  {
    title: 'मराठी',
    lang: 'mr',
    body: `<p>महाराष्ट्र हे भारतातील एक राज्य आहे. मराठी ही महाराष्ट्राची राजभाषा आहे. ज्ञानेश्वरी, तुकारामांचे अभंग आणि पु. ल. देशपांडे यांचे लेखन मराठी साहित्याची शान आहे.</p>
<p>आजचा दिवस खूप सुंदर आहे. पाऊस पडून गेल्यावर मातीचा सुगंध सगळीकडे दरवळत होता, आणि दूरवर डोंगरांवर ढगांची दाटी झाली होती.</p>
<p>मराठीतील खास अक्षर ळ: केळी, सकाळ, कळी, ओळख, खेळ, काळजी, वेळ, मळा.</p>
<p>संयुक्त अक्षरे: क्ष, ज्ञ, त्र, श्र, द्ध, द्य, ह्म, ङ्ग, ट्ट, स्त्री, कर्त्स्न्य, विद्यार्थी, अध्यक्ष, लक्ष्मी.</p>`,
  },
  {
    title: 'हिन्दी',
    lang: 'hi',
    body: `<p>हिन्दी भारत की राजभाषा है और देवनागरी लिपि में लिखी जाती है। यह विश्व की सबसे अधिक बोली जाने वाली भाषाओं में से एक है।</p>
<p>प्रेमचंद की कहानियाँ आज भी पाठकों को अपनी ओर खींचती हैं। ज़िन्दगी, फ़ायदा, क़िला, ख़ुशी, ग़ज़ल जैसे शब्दों में नुक़्ता का प्रयोग होता है।</p>
<p>ऑफ़िस, कॉलेज, डॉक्टर जैसे शब्दों में ऑ की मात्रा दिखती है। चंद्रबिंदु और अनुस्वार: हँसी, आँख, गाँव, कंधा, संस्कृत, हिंदी।</p>
<p>अंक: ० १ २ ३ ४ ५ ६ ७ ८ ९ — २०२६ में १२,५०० रुपये (₹१२,५००)।</p>`,
  },
  {
    title: 'संस्कृतम्',
    lang: 'sa',
    body: `<p>सत्यमेव जयते नानृतं सत्येन पन्था विततो देवयानः।</p>
<p>असतो मा सद्गमय। तमसो मा ज्योतिर्गमय। मृत्योर्मा अमृतं गमय॥</p>
<p>ॐ भूर्भुवः स्वः तत्सवितुर्वरेण्यं भर्गो देवस्य धीमहि धियो यो नः प्रचोदयात्॥</p>
<p>वक्रतुण्ड महाकाय सूर्यकोटि समप्रभ। निर्विघ्नं कुरु मे देव सर्वकार्येषु सर्वदा॥</p>
<p>वैदिक स्वरचिह्नैः सहितम्: अ॒ग्निमी॑ळे पु॒रोहि॑तं य॒ज्ञस्य॑ दे॒वमृ॒त्विज॑म्। होता॑रं रत्न॒धात॑मम्॥</p>`,
  },
  {
    title: 'Symbols and mixed text',
    lang: 'en',
    body: `<p>Math: ∑ ∫ ∂ √ ∞ ≈ ≠ ≤ ≥ ± × ÷ π Δ Ω λ μ</p>
<p>Arrows: → ← ↑ ↓ ↔ ⇒ ⇐ ⇔ ↦ ➜</p>
<p>Currency: ₹ $ € £ ¥ ₿ ₩ ₽ ¢</p>
<p>Other: † ‡ § ¶ • ◦ ★ ☆ ✓ ✗ № ℃ ℉ ½ ¼ ¾ ™ © ®</p>
<p>Mixed lines: ₹१२,५०० (≈ $150) → ३ × १२ = ३६ · वाच (Vach) ≤ वाचन · Café ☕ → चहा.</p>
<p>A long Devanagari word with no spaces, to check wrapping: ${'विद्यार्थ्यांच्या'.repeat(8)}</p>`,
  },
];

mkdirSync(outDir, { recursive: true });
const books = [
  ['tables-sample.epub', { id: 'tables', title: 'Vach table sample', language: 'en', chapters: tablesChapters }],
  ['devanagari-sample.epub', { id: 'devanagari', title: 'वाच', language: 'mr', chapters: devanagariChapters }],
];
for (const [file, spec] of books) {
  const bytes = await epub(spec);
  writeFileSync(join(outDir, file), bytes);
  console.log(`${file.padEnd(24)} ${bytes.length.toLocaleString('en-US').padStart(7)} bytes`);
  if (bytes.length > 100 * 1024) throw new Error(`${file} is over the 100 KB budget`);
}
